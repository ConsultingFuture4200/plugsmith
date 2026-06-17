#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { renderBlock, writeBlockToFile } from "../core/claudemd/block.js";
import {
  InstallUnavailableError,
  defaultClaudeMdPath,
  enabledRefsFromInventory,
  installComponents,
  nextBlockVersion,
  readLatestRecommendation,
  stackFromRecommendation,
} from "../core/claudemd/gen.js";
import { type ProviderName, loadConfig } from "../core/config.js";
import { getComponent } from "../core/db/components.js";
import { type DB, openStore } from "../core/db/store.js";
import { reconcile, scanInventory } from "../core/inventory/scanner.js";
import { selectProvider } from "../core/recommender/factory.js";
import {
  CostAbortedError,
  annotateStack,
  formatTokens,
  recommend,
} from "../core/recommender/index.js";
import type { ModelProvider } from "../core/recommender/provider.js";
import { search, sync } from "../core/registry/sync.js";
import type { Annotation, Component, InventoryItem, Recommendation, Scope } from "../core/types.js";
import { defaultWebRoot, serve } from "../server/index.js";

/**
 * `ccharness` CLI (PRD §5) — thin wrapper over `@ccharness/core`. Source of
 * truth for all state changes. The complete v1 command surface, no more:
 * sync, search, status, recommend, gen-claudemd, serve.
 *
 * Commands are scaffolded with their PRD-locked signatures; each action is
 * wired to its core function as the corresponding milestone lands.
 */
const program = new Command();

program
  .name("ccharness")
  .description(
    "Recommend a coherent, deconflicted Claude Code plugin/skill stack for the task at hand.",
  )
  .version("0.7.0");

program
  .command("sync")
  .description("refresh the index from configured marketplaces (PRD §4.1)")
  .action(async () => {
    const db = openStore();
    const config = loadConfig();
    const report = await sync(db, config);
    for (const source of report.sources) {
      if (source.error) {
        console.log(`${source.marketplace}: failed — ${source.error}`);
      } else {
        console.log(`${source.marketplace}: ${source.parsed} parsed, ${source.skipped} skipped`);
      }
    }
    console.log(`index version → ${report.newIndexVersion}`);
  });

program
  .command("search")
  .argument("<query>")
  .option("-c, --category <category>", "filter by category id or key")
  .description("query the index (PRD §4.1)")
  .action((query: string, opts: { category?: string }) => {
    const db = openStore();
    const results = search(db, query, opts.category != null ? { category: opts.category } : {});
    if (results.length === 0) {
      console.log("no matches");
      return;
    }
    for (const c of results) {
      console.log(formatResult(c));
    }
  });

program
  .command("status")
  .description("show installed + enabled components, annotated (PRD §4.2)")
  .action(() => {
    const db = openStore();
    const report = scanInventory({ projectPath: process.cwd() });
    const items = reconcile(db, report);
    if (items.length === 0) {
      console.log("no installed components found");
    } else {
      printStatus(db, items);
    }
    for (const u of report.unreadable) {
      console.log(`! unreadable: ${u.file} (${u.reason})`);
    }
  });

program
  .command("recommend")
  .argument("<task>")
  .option("--scope <scope>", "system | project")
  .option("--tight", "prefer a tight context budget")
  .option("--integrations <list>", "comma-separated required integrations")
  .option("--provider <provider>", "anthropic | local")
  .option("--yes", "bypass the paid-provider cost confirm")
  .option("--no-cache", "force a fresh model call")
  .description("the product: what to enable/install/disable, with reasons (PRD §4.3)")
  .action(async (task: string, opts: RecommendCliOptions) => {
    const db = openStore();
    const config = loadConfig();

    let provider: ModelProvider;
    try {
      provider = selectProvider(config, opts.provider);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    const scope: Scope = opts.scope === "project" ? "project" : "system";
    const integrations =
      opts.integrations != null
        ? opts.integrations
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined;

    try {
      const rec = await recommend(db, config, task, {
        scope,
        ...(opts.tight ? { tight: true } : {}),
        ...(integrations ? { integrations } : {}),
        provider,
        // commander sets `cache: false` for --no-cache; default true.
        noCache: opts.cache === false,
        // Paid-provider cost guard (PRD §4.8): confirm unless --yes.
        confirmCost: (p, candidateCount) => confirmCost(p, candidateCount, opts.yes === true),
      });
      printRecommendation(db, rec);
    } catch (err) {
      if (err instanceof CostAbortedError) {
        console.error("recommend: aborted — paid-provider call declined.");
        process.exitCode = 1;
        return;
      }
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command("gen-claudemd")
  .option("--scope <scope>", "system | project")
  .option("--path <file>", "target CLAUDE.md path")
  .option("--from-recommend <task>", "derive the stack from a prior `recommend <task>` run")
  .option("--components <list>", "comma-separated component refs to enable (overrides derivation)")
  .option("--write", "perform the in-place managed-block update (default: print to stdout)")
  .option("--install", "also shell out to `claude plugin install` for accepted install lines")
  .option("--yes", "bypass the --install confirm prompt")
  .description("emit the managed block; review-first by default (PRD §4.5)")
  .action(async (opts: GenClaudeMdCliOptions) => {
    const db = openStore();
    const config = loadConfig();
    const scope: Scope = opts.scope === "project" ? "project" : "system";
    const path = opts.path ?? defaultClaudeMdPath(scope, config);

    // 1. Choose the stack: explicit --components, else --from-recommend, else
    //    the currently enabled inventory for the scope (PRD §4.5).
    let enabled: string[];
    let install: string[] = [];
    if (opts.components != null) {
      enabled = splitList(opts.components);
    } else if (opts.fromRecommend != null) {
      const rec = readLatestRecommendation(db, opts.fromRecommend, scope);
      if (!rec) {
        console.error(
          `gen-claudemd: no cached recommendation for "${opts.fromRecommend}" (scope ${scope}). Run \`ccharness recommend\` first.`,
        );
        process.exitCode = 1;
        return;
      }
      const chosen = stackFromRecommendation(rec);
      enabled = chosen.enabled;
      install = chosen.install;
    } else {
      enabled = enabledRefsFromInventory(db, scope);
    }

    // 2. Render the block at the next version (bump if a block already exists).
    const version = nextBlockVersion(path, program.version() ?? "0.7.0");
    const block = renderBlock(version, enabled);

    if (!opts.write) {
      // Review-first default: print to stdout, no state change (PRD §4.5, §8).
      console.log(block);
      if (install.length > 0) {
        console.error(
          `\n(${install.length} install line(s): ${install.join(", ")}. Re-run with --write --install to act.)`,
        );
      }
      return;
    }

    // 3. --write: byte-safe managed-block update via the tested writer.
    const existedBefore = existsSync(path);
    const result = writeBlockToFile(path, block);
    const backupNote = existedBefore ? ` (backup at ${path}.bak)` : " (new file)";
    console.error(`gen-claudemd: ${result.mode} block v${version} in ${path}${backupNote}`);

    // 4. Optional install shell-out (UMB-140), behind an explicit confirm.
    if (opts.install && install.length > 0) {
      const ok = await confirmInstall(install, opts.yes === true);
      if (!ok) {
        console.error("gen-claudemd: install declined.");
        return;
      }
      try {
        const results = installComponents(
          db,
          install,
          scope === "project" ? { projectPath: process.cwd() } : {},
        );
        for (const r of results) {
          console.error(
            r.status === "installed"
              ? `  installed ${r.componentRef}`
              : `  FAILED ${r.componentRef} — ${r.detail ?? "unknown error"}`,
          );
        }
        console.error("gen-claudemd: inventory re-scanned.");
      } catch (err) {
        if (err instanceof InstallUnavailableError) {
          console.error(`gen-claudemd: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    }
  });

program
  .command("serve")
  .option("--port <n>", "port", "4575")
  .description("launch the read-only dashboard on localhost (PRD §4.6)")
  .action(async (opts: { port?: string }) => {
    const db = openStore();
    const config = loadConfig();
    const port = Number.parseInt(opts.port ?? "4575", 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`serve: invalid port "${opts.port}".`);
      process.exitCode = 1;
      return;
    }
    const webRoot = defaultWebRoot();
    try {
      const { url } = await serve(
        { db, config, projectPath: process.cwd(), ...(webRoot ? { webRoot } : {}) },
        port,
      );
      console.error(`ccharness serve: read-only dashboard on ${url} (localhost only).`);
      if (!webRoot) {
        console.error(
          "serve: web assets not built. Run `pnpm --dir web build`; the API is live in the meantime.",
        );
      }
    } catch (err) {
      console.error(`serve: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

/** One-line search result: name, trust tier, categories, context-cost (PRD §4.1). */
function formatResult(c: Component): string {
  const categories = c.categoryTags.length > 0 ? c.categoryTags.join(", ") : "uncategorized";
  const cost = c.contextCostFlag ? "context-costly" : "light";
  return `${c.name}  [${c.trustTier}]  ${categories}  (${cost})`;
}

/**
 * Render the inventory snapshot grouped by scope (PRD §4.2): enabled state,
 * what each component provides (category tags from the index), and a clear
 * marker for items not in the index.
 */
function printStatus(db: DB, items: InventoryItem[]): void {
  const scopes: Scope[] = ["system", "project"];
  for (const scope of scopes) {
    const group = items.filter((i) => i.scope === scope);
    if (group.length === 0) continue;
    console.log(`\n${scope} scope:`);
    for (const item of group) {
      console.log(`  ${formatInventoryItem(item)}`);
    }
  }

  // Context-cost total over the enabled, index-resolved stack (PRD §4.1): sum the
  // declared always-on token cost where known, mirroring the recommend summary.
  const enabledStack: Component[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.enabled || seen.has(item.componentRef)) continue;
    seen.add(item.componentRef);
    const resolved = getComponent(db, item.componentRef);
    if (resolved) enabledStack.push(resolved);
  }
  const { costlyCount, tokenBudget } = annotateStack(enabledStack);
  if (costlyCount > 0) {
    const tokenNote =
      tokenBudget != null ? ` (context: ~${formatTokens(tokenBudget)} always-on tokens)` : "";
    console.log(`\n${costlyCount} context-costly enabled component(s)${tokenNote}.`);
  }
}

/** Truncate a description to ~maxLen chars on a word boundary, with an ellipsis. */
function truncate(text: string, maxLen = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  const cut = flat.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * One-line inventory entry: enabled marker, ref, provides, index status (PRD
 * §4.2). For items in the index we show the index annotation. For items NOT in
 * the index we show the derived label read from their own definition — kind,
 * inferred categories, and a truncated description — flagged `derived` so it's
 * unambiguous the categories were inferred, not read from the marketplace index.
 */
function formatInventoryItem(item: InventoryItem): string {
  const state = item.enabled ? "[on] " : "[off]";
  let provides: string;
  if (item.resolved != null) {
    const tags = item.resolved.categoryTags;
    const cats = tags.length > 0 ? tags.join(", ") : "uncategorized";
    const cost = item.resolved.contextCostFlag ? ", context-costly" : "";
    const tok = item.resolved.contextTokens != null ? `, ~${item.resolved.contextTokens} tok` : "";
    const desc = item.resolved.description ? ` — ${truncate(item.resolved.description)}` : "";
    provides = `${item.resolved.trustTier} — ${cats}${cost}${tok}${desc}`;
  } else if (item.derived != null) {
    const kind = item.kind ?? (item.componentRef.includes("@") ? "plugin" : "skill");
    const cats =
      item.derived.categoryTags.length > 0 ? item.derived.categoryTags.join(", ") : "unclassified";
    const desc = item.derived.description ? ` — ${truncate(item.derived.description)}` : "";
    provides = `[${kind}] derived: ${cats}${desc}`;
  } else {
    provides = "not in index";
  }
  return `${state} ${item.componentRef}  (${provides})`;
}

/** Parsed `recommend` flags. commander maps --no-cache to `cache: false`. */
interface RecommendCliOptions {
  scope?: string;
  tight?: boolean;
  integrations?: string;
  provider?: ProviderName;
  yes?: boolean;
  cache?: boolean;
}

/** Parsed `gen-claudemd` flags (PRD §4.5, Milestone D). */
interface GenClaudeMdCliOptions {
  scope?: string;
  path?: string;
  fromRecommend?: string;
  components?: string;
  write?: boolean;
  install?: boolean;
  yes?: boolean;
}

/** Split a comma-separated CLI list into trimmed, non-empty refs. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Explicit confirm gate for the install shell-out (UMB-140). State-changing, so
 * it must be confirmed (or `--yes`) and refuses on a non-TTY without `--yes`
 * rather than acting unattended.
 */
async function confirmInstall(refs: string[], yes: boolean): Promise<boolean> {
  console.error(`About to \`claude plugin install\`: ${refs.join(", ")}`);
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error("gen-claudemd: not a TTY and --yes not given; declining install.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Proceed with install? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Coarse per-candidate token budget for the pre-call estimate (PRD §4.8). */
const EST_TOKENS_PER_CANDIDATE = 60;
const EST_PROMPT_OVERHEAD_TOKENS = 200;

/**
 * Paid-provider cost guard (PRD §4.8): show an order-of-magnitude token estimate
 * and require an interactive y/N confirm. Free providers never reach here (the
 * recommender only calls this hook for `provider.paid`). `--yes` bypasses.
 *
 * The estimate is intentionally coarse — the exact prompt isn't built until
 * inside `recommend`, and the guard only needs to set expectations, not bill.
 */
async function confirmCost(
  provider: ModelProvider,
  candidateCount: number,
  yes: boolean,
): Promise<boolean> {
  const estTokens = EST_PROMPT_OVERHEAD_TOKENS + candidateCount * EST_TOKENS_PER_CANDIDATE;
  console.error(
    `Paid provider "${provider.name}": ~${estTokens} input tokens over ${candidateCount} candidate(s) (estimate).`,
  );
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error("recommend: not a TTY and --yes not given; declining paid call.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Proceed with the paid call? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Print a grounded recommendation (PRD §4.3, §4.4). Each enable/install/disable
 * line carries its reason AND an inline trust-tier + MCP/hook surface marker —
 * a cheap mitigation for the §10 persuasion risk: the fluent reason sits next to
 * the hard facts (who vouches for it, what it costs your context). Then the
 * conflict/context-cost annotations and the context-cost summary.
 */
function printRecommendation(db: DB, rec: Recommendation): void {
  console.log(`Task: ${rec.task}`);
  console.log(
    `Provider: ${rec.provider}${rec.cached ? " (cached)" : ""}  index: ${rec.indexVersion}`,
  );

  if (rec.lines.length === 0) {
    console.log("\nNo actions recommended.");
  } else {
    console.log("\nRecommended actions:");
    for (const line of rec.lines) {
      console.log(`  ${formatRecLine(db, line.action, line.componentRef, line.reason)}`);
    }
  }

  if (rec.annotations.length > 0) {
    console.log("\nConflicts & context cost:");
    for (const a of rec.annotations) {
      console.log(`  ${formatAnnotation(a)}`);
    }
  }

  const s = rec.contextCostSummary;
  console.log("\nContext-cost summary:");
  const tokenNote =
    s.tokenBudget != null ? ` (context: ~${formatTokens(s.tokenBudget)} always-on tokens)` : "";
  console.log(
    `  ${s.costlyCount} context-costly component(s) in the proposed stack${s.tightRequested ? " (tight context requested)" : ""}${tokenNote}.`,
  );
  if (s.note) console.log(`  ${s.note}`);
}

/**
 * One recommendation line: verb, ref, the trust-tier + MCP/hook surface marker
 * joined from the index (the §10 mitigation), then the model's reason.
 */
function formatRecLine(db: DB, action: string, componentRef: string, reason: string): string {
  const verb = action.toUpperCase().padEnd(7);
  const marker = surfaceMarker(getComponent(db, componentRef));
  return `${verb} ${componentRef}  ${marker}\n            ${reason}`;
}

/**
 * Inline trust-tier + surface marker for a component (PRD §10 mitigation): trust
 * tier, MCP-server count, and hook count — the hard surface a persuasive reason
 * must be weighed against. "[unknown — not in index]" when it doesn't resolve.
 */
function surfaceMarker(c: Component | undefined): string {
  if (!c) return "[unknown — not in index]";
  const parts = [`trust:${c.trustTier}`];
  const mcp = c.bundles.mcpServers.length;
  const hooks = c.bundles.hooks.length;
  if (mcp > 0) parts.push(`mcp:${mcp}`);
  if (hooks > 0) parts.push(`hooks:${hooks}`);
  if (c.contextCostFlag) parts.push("context-costly");
  return `[${parts.join(" ")}]`;
}

/** One annotation line with a severity marker (PRD §4.4). */
function formatAnnotation(a: Annotation): string {
  const tag = a.severity === "conflict" ? "CONFLICT" : a.severity === "warn" ? "warn" : "info";
  return `[${tag}] (${a.kind}) ${a.message}`;
}

program.parseAsync().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
