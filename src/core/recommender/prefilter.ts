import { getAllComponents, getComponentsByCategory } from "../db/components.js";
import type { DB } from "../db/store.js";
import { TAXONOMY } from "../taxonomy.js";
import type { Component, InventoryItem } from "../types.js";

/**
 * Deterministic pre-filter (PRD §4.3 step 1, Milestone C step 1).
 *
 * From the task prose + flags, narrow the full index to a plausible candidate
 * set (likely categories → real components, preferring already-installed and
 * higher-trust). This keeps the model prompt small and bounded, and bounds what
 * the model is allowed to choose. Breadth is tunable (PRD §12 Q2).
 *
 * This is intentionally deterministic and cheap — NOT the matcher. The LLM does
 * the judgment; this just bounds the choice set.
 */
export interface PrefilterInput {
  task: string;
  inventory: InventoryItem[];
  breadth: "narrow" | "balanced" | "generous";
  integrations?: string[];
}

/**
 * Keyword/signal map: category key → words that, when seen in task prose,
 * suggest that category is relevant. Deliberately a hand-seeded map over the
 * taxonomy (PRD §3); it bounds the candidate set, it does NOT make the pick —
 * the LLM does that (PRD §4.3). Cheap to extend as the taxonomy evolves.
 */
const SIGNALS: Record<string, string[]> = {
  "project-mgmt": ["plan", "spec", "prd", "roadmap", "milestone", "requirements", "project", "phase"],
  "context-mgmt": ["context", "token", "prompt", "window", "compaction", "summarize"],
  memory: ["memory", "remember", "persist", "recall", "knowledge", "notes", "vault"],
  "code-quality": ["lint", "format", "quality", "refactor", "clean", "style", "guardrail"],
  security: ["security", "secret", "vulnerability", "supply chain", "audit", "credential", "cve"],
  git: ["git", "commit", "branch", "rebase", "merge", "pull request", "pr", "vcs"],
  "code-review": ["review", "pr review", "code review", "feedback", "critique"],
  testing: ["test", "tdd", "coverage", "vitest", "jest", "pytest", "ci", "verify", "verification"],
  "multi-agent": ["agent", "orchestrate", "orchestration", "multi-agent", "subagent", "pipeline", "swarm"],
  observability: ["observability", "telemetry", "logging", "metrics", "trace", "monitor"],
  integrations: ["mcp", "integration", "connector", "api", "slack", "github", "notion", "jira", "linear", "database", "postgres", "postgresql", "sql", "supabase", "stripe"],
  domain: ["domain", "metrc", "shopify", "cannabis", "ecommerce", "amazon", "formulation"],
  "output-styling": ["format output", "styling", "markdown", "render", "presentation", "report style"],
};

/** How many candidates the breadth knob admits (PRD §12 Q2). */
const BREADTH_LIMITS: Record<PrefilterInput["breadth"], number> = {
  narrow: 8,
  balanced: 16,
  generous: 30,
};

/** Trust tiers ranked best-first for deterministic ordering (PRD §4.1). */
const TRUST_RANK: Record<string, number> = {
  official: 0,
  partner: 1,
  community: 2,
};

/**
 * Map task prose → likely category keys via the signal map (PRD §4.3 step 1).
 * Always includes any category implied by `integrations` (those are explicit
 * operator requirements, not guesses).
 */
function likelyCategories(task: string, integrations?: string[]): Set<string> {
  const lower = task.toLowerCase();
  const keys = new Set<string>();
  for (const cat of TAXONOMY) {
    const words = SIGNALS[cat.key] ?? [];
    if (words.some((w) => lower.includes(w))) keys.add(cat.key);
  }
  if (integrations && integrations.length > 0) keys.add("integrations");
  return keys;
}

/**
 * task → likely category keys (keyword/signal map), categories → components
 * from the index, rank by (installed, trust tier), include install-candidates
 * for likely-but-uncovered categories, truncate by breadth. Returns the
 * candidate set the model will see (PRD §4.3 step 1).
 */
export function prefilter(db: DB, input: PrefilterInput): Component[] {
  const installedRefs = new Set(input.inventory.map((i) => i.componentRef));
  const categories = likelyCategories(input.task, input.integrations);

  // Collect candidates from the matched categories. Both enabled-or-disabled
  // installed components AND uncovered install-candidates belong here: the model
  // must be able to propose installs, not only enables (PRD §4.3 output verbs).
  const byId = new Map<string, Component>();
  for (const key of categories) {
    for (const c of getComponentsByCategory(db, key)) {
      byId.set(c.id, c);
    }
  }

  // Always surface already-installed components even if their category wasn't a
  // keyword hit — the operator's current stack is relevant context for the model
  // (e.g. to propose a `disable`).
  if (installedRefs.size > 0) {
    for (const c of getAllComponents(db)) {
      if (installedRefs.has(c.id) || installedRefs.has(c.name)) byId.set(c.id, c);
    }
  }

  const candidates = [...byId.values()];

  // Rank: installed first (the model reasons about the live stack), then higher
  // trust, then name for stable, deterministic ordering.
  candidates.sort((a, b) => {
    const aInstalled = installedRefs.has(a.id) || installedRefs.has(a.name);
    const bInstalled = installedRefs.has(b.id) || installedRefs.has(b.name);
    if (aInstalled !== bInstalled) return aInstalled ? -1 : 1;
    const trustDelta = (TRUST_RANK[a.trustTier] ?? 9) - (TRUST_RANK[b.trustTier] ?? 9);
    if (trustDelta !== 0) return trustDelta;
    return a.name.localeCompare(b.name);
  });

  return candidates.slice(0, BREADTH_LIMITS[input.breadth]);
}
