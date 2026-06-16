#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../core/config.js";
import { openStore } from "../core/db/store.js";
import { reconcile, scanInventory } from "../core/inventory/scanner.js";
import { search, sync } from "../core/registry/sync.js";
import type { Component, InventoryItem, Scope } from "../core/types.js";

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
      printStatus(items);
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
  .action(() => notImplemented("recommend", "Milestone C"));

program
  .command("gen-claudemd")
  .option("--scope <scope>", "system | project")
  .option("--path <file>", "target CLAUDE.md path")
  .option("--write", "perform the in-place managed-block update (default: print to stdout)")
  .description("emit the managed block; review-first by default (PRD §4.5)")
  .action(() => notImplemented("gen-claudemd", "Milestone D"));

program
  .command("serve")
  .option("--port <n>", "port", "4575")
  .description("launch the read-only dashboard on localhost (PRD §4.6)")
  .action(() => notImplemented("serve", "Milestone E"));

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
function printStatus(items: InventoryItem[]): void {
  const scopes: Scope[] = ["system", "project"];
  for (const scope of scopes) {
    const group = items.filter((i) => i.scope === scope);
    if (group.length === 0) continue;
    console.log(`\n${scope} scope:`);
    for (const item of group) {
      console.log(`  ${formatInventoryItem(item)}`);
    }
  }
}

/** One-line inventory entry: enabled marker, ref, provides, index status. */
function formatInventoryItem(item: InventoryItem): string {
  const state = item.enabled ? "[on] " : "[off]";
  let provides: string;
  if (item.resolved == null) {
    provides = "not in index";
  } else {
    const tags = item.resolved.categoryTags;
    const cats = tags.length > 0 ? tags.join(", ") : "uncategorized";
    const cost = item.resolved.contextCostFlag ? ", context-costly" : "";
    provides = `${item.resolved.trustTier} — ${cats}${cost}`;
  }
  return `${state} ${item.componentRef}  (${provides})`;
}

function notImplemented(cmd: string, milestone: string): never {
  console.error(`ccharness ${cmd}: not yet implemented (${milestone}).`);
  process.exitCode = 1;
  throw new Error(`${cmd} not implemented`);
}

program.parseAsync().catch((err) => {
  if (err instanceof Error && err.message.endsWith("not implemented")) return;
  console.error(err);
  process.exitCode = 1;
});
