/**
 * Milestone C exit-gate driver (UMB-138). Runs the REAL recommender pipeline
 * (prefilter → provider → validate → annotate → cache) against a realistic
 * seeded index + inventory, over 8 real operator tasks.
 *
 * Provider note: for this run the operator asked Claude to ACT as the local LLM,
 * so the provider is a `scripted` adapter that returns proposals authored by
 * Claude (filled into PROPOSALS below) instead of calling Ollama. Everything
 * else — prefilter, grounding/validation, conflict + context-cost annotation,
 * caching — is the real product code.
 *
 * Two phases, controlled by whether PROPOSALS is filled:
 *   Phase A (PROPOSALS empty): print the prefilter candidate set per task, exit.
 *   Phase B (PROPOSALS filled): run the full pipeline + judge.
 *
 * Run: pnpm exec tsx scripts/exit-gate.ts
 */
import { openStore } from "../src/core/db/store.js";
import { upsertComponents, replaceInventory, getInventory } from "../src/core/db/components.js";
import { prefilter } from "../src/core/recommender/prefilter.js";
import { recommend } from "../src/core/recommender/index.js";
import { ProviderError, type ModelProvider } from "../src/core/recommender/provider.js";
import type { Component, InventoryItem, RecLine } from "../src/core/types.js";
import type { PlugsmithConfig } from "../src/core/config.js";

function comp(o: Partial<Component> & { id: string; name: string; categoryTags: string[] }): Component {
  return {
    marketplaceId: "seed",
    trustTier: "community",
    bundles: { skills: [], commands: [], hooks: [], mcpServers: [] },
    contextCostFlag: false,
    singletonCategories: [],
    compatibility: [],
    ...o,
  };
}
const mcp = (id: string, name: string, desc: string, trust: Component["trustTier"] = "partner"): Component =>
  comp({ id, name, categoryTags: ["integrations"], trustTier: trust, contextCostFlag: true,
    bundles: { skills: [], commands: [], hooks: [], mcpServers: [name] }, description: desc });

const INDEX: Component[] = [
  comp({ id: "basic-memory", name: "basic-memory", categoryTags: ["memory"], singletonCategories: ["memory"], description: "File-based persistent memory across sessions." }),
  comp({ id: "claude-reflect", name: "claude-reflect", categoryTags: ["memory"], singletonCategories: ["memory"], description: "Auto-updates memory from corrections." }),
  comp({ id: "context-mode", name: "context-mode", categoryTags: ["context-mgmt"], singletonCategories: ["context-mgmt"], trustTier: "partner", contextCostFlag: true,
    bundles: { skills: [], commands: [], hooks: [{ event: "SessionStart" }], mcpServers: [] }, description: "Keeps large tool output out of context." }),
  comp({ id: "gsd", name: "gsd", categoryTags: ["project-mgmt"], description: "Spec-driven phased project workflow." }),
  comp({ id: "test-engineer", name: "test-engineer", categoryTags: ["testing"], trustTier: "official", description: "Writes/runs tests, diagnoses CI failures." }),
  comp({ id: "linus-review", name: "linus-review", categoryTags: ["code-review"], description: "Kernel-quality code review." }),
  comp({ id: "git-check", name: "git-check", categoryTags: ["git"], trustTier: "official", description: "Pre-flight for risky git operations." }),
  comp({ id: "supply-chain-audit", name: "supply-chain-audit", categoryTags: ["security"], trustTier: "partner", description: "Static permission/supply-chain review." }),
  comp({ id: "simplify", name: "simplify", categoryTags: ["code-quality"], trustTier: "official", description: "Post-implementation cleanup/refactor." }),
  comp({ id: "foreman", name: "foreman", categoryTags: ["multi-agent"], description: "Autonomous multi-issue pipeline orchestrator." }),
  mcp("github-mcp", "github-mcp", "GitHub PRs/issues over MCP."),
  mcp("linear-mcp", "linear-mcp", "Linear issues/projects over MCP."),
  mcp("shopify-mcp", "shopify-mcp", "Shopify store admin over MCP."),
  mcp("postgres-mcp", "postgres-mcp", "Postgres query/introspection over MCP.", "community"),
  comp({ id: "metrc", name: "metrc", categoryTags: ["domain"], description: "Metrc cannabis track-and-trace API specialist." }),
  comp({ id: "amazon-sp-api", name: "amazon-sp-api", categoryTags: ["domain"], description: "Amazon SP-API listing/inventory ops." }),
  comp({ id: "output-styler", name: "output-styler", categoryTags: ["output-styling"], description: "Formats output/markdown/reports." }),
  comp({ id: "token-telemetry", name: "token-telemetry", categoryTags: ["observability"], contextCostFlag: true,
    bundles: { skills: [], commands: [], hooks: [{ event: "UserPromptSubmit" }], mcpServers: [] }, description: "Per-session token telemetry." }),
];

const INVENTORY: InventoryItem[] = [
  { componentRef: "basic-memory", scope: "system", enabled: true, sourceFile: "~/.claude/settings.json", scannedAt: "2026-06-16" },
  { componentRef: "gsd", scope: "system", enabled: true, sourceFile: "~/.claude/settings.json", scannedAt: "2026-06-16" },
  { componentRef: "git-check", scope: "system", enabled: true, sourceFile: "~/.claude/settings.json", scannedAt: "2026-06-16" },
  { componentRef: "context-mode", scope: "system", enabled: true, sourceFile: "~/.claude/settings.json", scannedAt: "2026-06-16" },
];

interface Task { task: string; tight?: boolean; integrations?: string[] }
const TASKS: Task[] = [
  { task: "Refactor the Krunchy Kids Amazon SP-API listing sync script that has no tests" },
  { task: "Write a GMP compliance PRD for Heron Labs and track it through phases" },
  { task: "Review a security-sensitive auth change in a payment flow before merging" },
  { task: "Pull Metrc package data and reconcile it against our inventory system", integrations: ["metrc"] },
  { task: "Set up a multi-agent pipeline to work through my Linear backlog", integrations: ["linear"] },
  { task: "Debug a failing Shopify webhook and keep context tight", tight: true, integrations: ["shopify"] },
  { task: "Build a React dashboard with a Postgres backend for sales analytics" },
  { task: "Capture session knowledge into my Obsidian vault and remember decisions across sessions" },
];

// Claude-authored proposals (acting as the local LLM), keyed by exact task text.
// Each line may only reference an id from that task's Phase-A candidate set;
// grounding will drop anything else (see the deliberate "jira-mcp" in Task 5).
const PROPOSALS: Record<string, RecLine[]> = {
  "Refactor the Krunchy Kids Amazon SP-API listing sync script that has no tests": [
    { action: "install", componentRef: "test-engineer", reason: "Refactoring untested code — add a TDD guardrail to lock current behavior before changing it." },
    { action: "install", componentRef: "amazon-sp-api", reason: "The task is SP-API listing work; the domain skill knows the API surface and quirks." },
    { action: "install", componentRef: "simplify", reason: "Run a cleanup pass for reuse/quality after the refactor lands." },
  ],
  "Write a GMP compliance PRD for Heron Labs and track it through phases": [
    // Coherent "already covered": gsd (installed, enabled) drives spec→phases and
    // basic-memory (installed, enabled) persists decisions. Nothing to change.
  ],
  "Review a security-sensitive auth change in a payment flow before merging": [
    { action: "install", componentRef: "linus-review", reason: "Security-sensitive auth/payment change — get a kernel-quality review before merge." },
    { action: "install", componentRef: "supply-chain-audit", reason: "Payment/auth path; a static permission/supply-chain review catches risky access." },
  ],
  "Pull Metrc package data and reconcile it against our inventory system": [
    { action: "install", componentRef: "metrc", reason: "Task is Metrc package data; the domain specialist handles its API and state rules." },
    { action: "install", componentRef: "test-engineer", reason: "Reconciliation logic should be covered by tests so the match can be trusted." },
  ],
  "Set up a multi-agent pipeline to work through my Linear backlog": [
    { action: "install", componentRef: "foreman", reason: "Working a backlog autonomously is exactly the multi-issue orchestration foreman does." },
    { action: "install", componentRef: "linear-mcp", reason: "The backlog lives in Linear; the connector lets the pipeline read and update issues." },
    { action: "install", componentRef: "jira-mcp", reason: "(DELIBERATE) reference a component not in the candidate set — should be dropped by grounding." },
  ],
  "Debug a failing Shopify webhook and keep context tight": [
    { action: "install", componentRef: "shopify-mcp", reason: "Need Shopify admin access to inspect the webhook delivery and payloads." },
    { action: "install", componentRef: "github-mcp", reason: "Cross-reference the webhook handler code hosted in the repo." },
  ],
  "Build a React dashboard with a Postgres backend for sales analytics": [
    // Prefilter surfaced only already-installed components — nothing relevant to
    // a React/Postgres dashboard reached the candidate set, so there is nothing
    // grounded to propose. (This is the finding, not a model failure.)
  ],
  "Capture session knowledge into my Obsidian vault and remember decisions across sessions": [
    { action: "install", componentRef: "claude-reflect", reason: "Auto-captures decisions from corrections — useful for remembering across sessions." },
  ],
};

function seed() {
  const db = openStore(":memory:");
  db.prepare("INSERT INTO marketplaces(id,name,git_url,trust_default,kind) VALUES('seed','seed','local','community','custom')").run();
  upsertComponents(db, INDEX);
  replaceInventory(db, INVENTORY);
  db.prepare("INSERT INTO meta(key,value) VALUES('index_version','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  return db;
}

function scripted(): ModelProvider & { calls: number } {
  const p = { name: "local(claude)", paid: false, calls: 0,
    async propose(input: Parameters<ModelProvider["propose"]>[0]) {
      p.calls++;
      const lines = PROPOSALS[input.task];
      if (!lines) throw new ProviderError(`no scripted proposal for task: ${input.task}`);
      return { lines };
    } };
  return p;
}

const config = { prefilterBreadth: "generous", defaultProvider: "local" } as unknown as PlugsmithConfig;

function phaseA() {
  const db = seed();
  const inv = getInventory(db);
  const installed = new Set(inv.map((i) => i.componentRef));
  console.log("# PHASE A — prefilter candidate sets (the only ids a proposal may reference)\n");
  for (let i = 0; i < TASKS.length; i++) {
    const t = TASKS[i]!;
    const cands = prefilter(db, { task: t.task, inventory: inv, breadth: "generous",
      ...(t.integrations ? { integrations: t.integrations } : {}) });
    console.log(`## Task ${i + 1}${t.tight ? " [--tight]" : ""}${t.integrations ? ` [int=${t.integrations}]` : ""}: ${t.task}`);
    for (const c of cands) {
      const inst = installed.has(c.id) ? " INSTALLED" : "";
      const cost = c.contextCostFlag ? " costly" : "";
      const sing = c.singletonCategories.length ? ` singleton:${c.singletonCategories.join(",")}` : "";
      console.log(`   ${c.id.padEnd(20)} [${c.trustTier}] ${c.categoryTags.join("/")}${cost}${sing}${inst}`);
    }
    console.log("");
  }
}

async function phaseB() {
  const db = seed();
  const provider = scripted();
  console.log("# PHASE B — full pipeline (Claude as local LLM)\n");
  let conflicts = 0, costNotes = 0, errors = 0, lines = 0, dropped = 0;
  for (let i = 0; i < TASKS.length; i++) {
    const t = TASKS[i]!;
    console.log(`\n## Task ${i + 1}: ${t.task}${t.tight ? "  [--tight]" : ""}`);
    try {
      const rec = await recommend(db, config, t.task, { provider, scope: "system",
        ...(t.tight ? { tight: true } : {}), ...(t.integrations ? { integrations: t.integrations } : {}) });
      for (const l of rec.lines) { lines++; console.log(`  ${l.action.toUpperCase().padEnd(7)} ${l.componentRef.padEnd(20)} — ${l.reason}`); }
      for (const a of rec.annotations) {
        console.log(`  [${a.severity}/${a.kind}] ${a.message}`);
        if (a.kind === "singleton" && a.severity === "conflict") conflicts++;
        if (a.kind === "context-cost") costNotes++;
        if (a.kind === "command" && /Dropped/.test(a.message)) dropped++;
      }
      console.log(`  (cached=${rec.cached} costly=${rec.contextCostSummary.costlyCount} calls=${provider.calls})`);
    } catch (e) { errors++; console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const before = provider.calls;
  const again = await recommend(db, config, TASKS[0]!.task, { provider, scope: "system" });
  console.log(`\n## Cache check — re-ran Task 1: cached=${again.cached}, calls before=${before} after=${provider.calls} (delta ${provider.calls - before})`);
  console.log(`\n# SUMMARY tasks=${TASKS.length} errors=${errors} lines=${lines} singletonConflicts=${conflicts} contextCostNotes=${costNotes} hallucinationsDropped=${dropped} cacheFree=${again.cached && provider.calls === before}`);
}

const ready = Object.keys(PROPOSALS).length > 0;
(ready ? phaseB() : Promise.resolve(phaseA())).catch((e) => { console.error("FATAL:", e); process.exit(1); });
