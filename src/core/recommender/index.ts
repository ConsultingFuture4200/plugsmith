import { createHash } from "node:crypto";
import type { PlugsmithConfig } from "../config.js";
import { getComponent, getInventory } from "../db/components.js";
import { type DB, indexVersion } from "../db/store.js";
import {
  type HookBasePaths,
  hooksByComponentId,
  readHookRegistrations,
} from "../inventory/hooks.js";
import type { Annotation, Component, InventoryItem, Recommendation } from "../types.js";
import { annotateStack } from "./conflicts.js";
import { prefilter } from "./prefilter.js";
import { type ModelProvider, ProviderError } from "./provider.js";
import { validateProposal } from "./validate.js";

/**
 * Recommender orchestration (PRD §4.3, Milestone C) — the product.
 *
 * Wires the pipeline:
 *   pre-filter (deterministic) → LLM proposal (provider) →
 *   grounding/validation (deterministic) → conflict/context-cost annotation →
 *   cache.
 *
 * The LLM does judgment; the index does truth. The deterministic stages bound
 * the model on both ends.
 */
export interface RecommendOptions {
  scope?: "system" | "project";
  projectPath?: string;
  tight?: boolean;
  integrations?: string[];
  provider?: ModelProvider;
  /** Skip the cache read/write for a forced fresh call (PRD §4.8 `--no-cache`). */
  noCache?: boolean;
  /**
   * Cost-guard hook (PRD §4.8). Called BEFORE a paid provider runs; return false
   * to abort. The local/fake provider is free, so this is never invoked for it.
   * Bypassed entirely by `--yes` at the CLI (which passes a hook that returns
   * true). Interface only here — the CLI supplies the actual confirm prompt.
   */
  confirmCost?: (provider: ModelProvider, candidateCount: number) => Promise<boolean> | boolean;
  /**
   * Injectable base paths for the real hook-matcher reader (PRD §4.4). Defaults
   * to the operator's `~/.claude`; tests pass a temp dir so the overlay is
   * hermetic and never reads the real machine.
   */
  hookBasePaths?: HookBasePaths;
}

/** Raised when the operator declines the paid-provider cost confirm (PRD §4.8). */
export class CostAbortedError extends Error {}

/**
 * Normalize a task string for cache keying (PRD §4.8): lowercased, whitespace
 * collapsed, trimmed. Identical intent → identical signature → cache hit.
 */
function taskSignature(task: string): string {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

interface RecCacheRow {
  proposal: string;
  provider: string;
}

/**
 * Read a cached Recommendation for (signature, index-version, scope). The
 * index-version in the key means a `sync` (which bumps it) implicitly
 * invalidates the cache (PRD §4.8).
 */
function readCache(
  db: DB,
  signature: string,
  version: string,
  scope: string,
): Recommendation | undefined {
  const row = db
    .prepare(
      "SELECT proposal, provider FROM rec_cache WHERE task_signature = ? AND index_version = ? AND scope = ?",
    )
    .get(signature, version, scope) as RecCacheRow | undefined;
  if (!row) return undefined;
  const rec = JSON.parse(row.proposal) as Recommendation;
  return { ...rec, cached: true };
}

/** Write-through cache on a fresh recommendation (PRD §4.8). */
function writeCache(
  db: DB,
  signature: string,
  version: string,
  scope: string,
  rec: Recommendation,
): void {
  db.prepare(
    /* sql */ `
    INSERT INTO rec_cache (task_signature, index_version, scope, proposal, provider, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_signature, index_version, scope) DO UPDATE SET
      proposal = excluded.proposal,
      provider = excluded.provider,
      created_at = excluded.created_at
  `,
  ).run(
    signature,
    version,
    scope,
    JSON.stringify({ ...rec, cached: false }),
    rec.provider,
    new Date().toISOString(),
  );
}

/**
 * Orchestrate the full pipeline (PRD §4.3, Milestone C steps 1-6). Cache by
 * (task-signature + index-version + scope); invalidate implicitly on `sync`.
 * Compose the Recommendation from validated lines + annotateStack() output.
 */
export async function recommend(
  db: DB,
  config: PlugsmithConfig,
  task: string,
  opts: RecommendOptions = {},
): Promise<Recommendation> {
  const provider = opts.provider;
  if (!provider) {
    throw new ProviderError("recommend: no model provider supplied");
  }

  const scope = opts.scope ?? "system";
  const version = indexVersion(db);
  const signature = taskSignature(task);

  // Cache read (PRD §4.8): on hit, zero provider calls.
  if (!opts.noCache) {
    const hit = readCache(db, signature, version, scope);
    if (hit) return hit;
  }

  const inventory: InventoryItem[] = getInventory(db);

  // 1. Deterministic pre-filter — bounds the prompt and the choice set.
  const candidates = prefilter(db, {
    task,
    inventory,
    breadth: config.prefilterBreadth,
    ...(opts.integrations ? { integrations: opts.integrations } : {}),
  });

  // Provider-aware cost guard (PRD §4.8): only paid providers gate; free ones
  // pass straight through. The CLI supplies the actual confirm prompt.
  if (provider.paid && opts.confirmCost) {
    const ok = await opts.confirmCost(provider, candidates.length);
    if (!ok) {
      throw new CostAbortedError("recommend: paid-provider call declined by cost guard");
    }
  }

  // 2. LLM proposal (strict JSON, PRD §4.7). Malformed → ProviderError, loud.
  const proposal = await provider.propose({
    task,
    candidates,
    inventory,
    flags: {
      ...(opts.tight !== undefined ? { tight: opts.tight } : {}),
      ...(opts.integrations ? { integrations: opts.integrations } : {}),
      scope,
    },
  });

  // 3. Grounding/validation — hallucinated lines dropped loudly (PRD §4.3 step 3).
  const { valid, hallucinated, stack } = validateProposal(proposal, candidates);

  // Build the EFFECTIVE post-action stack the operator would actually run:
  // proposed enables+installs PLUS components already enabled in inventory, MINUS
  // anything the proposal disables. Conflict/context-cost must reason about live
  // inventory (PRD §4.4, §1.1) — otherwise recommending a second memory engine
  // while one is already installed slips through. Installed items not in the
  // index can't be reasoned about and are skipped.
  const disabledRefs = new Set(
    valid.filter((l) => l.action === "disable").map((l) => l.componentRef),
  );
  const effectiveStack = [...stack];
  const inStack = new Set(stack.map((c) => c.id));
  for (const item of inventory) {
    if (!item.enabled) continue;
    const resolved = getComponent(db, item.componentRef);
    if (!resolved || inStack.has(resolved.id) || disabledRefs.has(resolved.id)) continue;
    effectiveStack.push(resolved);
    inStack.add(resolved.id);
  }

  // Overlay REAL hook matchers (PRD §4.4, Hook-matchers phase). The catalog only
  // carries event names; the matcher granularity lives in the installed plugins'
  // own hook configs on disk (see docs/milestone-0-findings.md §2). Replace each
  // effective-stack component's catalog hooks with its real `{event, matcher?}`
  // list when present, keyed by component id == `<plugin>@<marketplace>` ref. A
  // true collision (same event AND matcher across two components) then warns,
  // while benign co-registration on the same event with different matchers does
  // not; components without a real config keep their event-only catalog entries.
  const realHooks = hooksByComponentId(readHookRegistrations(opts.hookBasePaths ?? {}));
  const matchedStack: Component[] = effectiveStack.map((c) => {
    const hooks = realHooks.get(c.id);
    return hooks ? { ...c, bundles: { ...c.bundles, hooks } } : c;
  });

  // 4. Conflict + context-cost annotation — hard facts over the effective stack (PRD §4.4).
  const {
    annotations: stackAnnotations,
    costlyCount,
    tokenBudget,
  } = annotateStack(matchedStack, {
    ...(opts.tight !== undefined ? { tight: opts.tight } : {}),
  });

  // Surface dropped hallucinations as a warn annotation — never hidden.
  const annotations: Annotation[] = [...stackAnnotations];
  if (hallucinated.length > 0) {
    annotations.push({
      severity: "warn",
      kind: "command",
      message: `Dropped ${hallucinated.length} proposed line(s) referencing unknown component(s): ${hallucinated
        .map((l) => l.componentRef)
        .join(", ")}. Not in the index.`,
      componentRefs: hallucinated.map((l) => l.componentRef),
    });
  }

  const recommendation: Recommendation = {
    task,
    lines: valid,
    annotations,
    contextCostSummary: {
      costlyCount,
      tightRequested: opts.tight === true,
      ...(tokenBudget != null ? { tokenBudget } : {}),
      ...(opts.tight && costlyCount > 1
        ? { note: "Stack is hook-/MCP-heavy despite a tight-context request." }
        : {}),
    },
    provider: provider.name,
    cached: false,
    indexVersion: version,
  };

  // 5. Write-through cache (PRD §4.8).
  if (!opts.noCache) {
    writeCache(db, signature, version, scope, recommendation);
  }

  return recommendation;
}

export { annotateStack, formatTokens } from "./conflicts.js";
export { prefilter } from "./prefilter.js";
export { validateProposal } from "./validate.js";
