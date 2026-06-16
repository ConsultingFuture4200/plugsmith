/**
 * Milestone-0 step-4 local-model validation driver (UMB-138).
 *
 * Unlike scripts/exit-gate.ts (which seeds an in-memory index and scripts the
 * proposals with Claude acting as the LLM), this driver runs the FULL REAL
 * pipeline end-to-end against real machine state:
 *   - the REAL synced store at openStore()'s default path (~/.ccharness),
 *     populated by `node dist/cli/index.js sync`,
 *   - the REAL operator inventory scanned into that store,
 *   - the REAL localProvider hitting Ollama at the configured baseUrl/model.
 *
 * It runs recommend() over the 8 operator tasks (scope:"system"), capturing per
 * task: schema-valid JSON on the first call vs after the single repair retry vs
 * a loud ProviderError; the proposed enable/install/disable lines; whether any
 * conflict / context-cost annotations fired on real data; and the token budget.
 * Task 1 is re-run to confirm a free cache hit. The final block tallies
 * JSON-reliability across the 8 tasks — the Milestone-0 step-4 finding.
 *
 * The repair retry is observed by wrapping the provider's fetch transport and
 * counting round-trips per propose() call: 1 round-trip ⇒ valid on first call,
 * 2 round-trips ⇒ the repair retry was needed.
 *
 * Model is overridable via CCHARNESS_GATE_MODEL so the same driver can compare
 * qwen3:4b against qwen2.5:3b without code changes.
 *
 * Run: pnpm exec tsx scripts/real-gate.ts
 *      CCHARNESS_GATE_MODEL=qwen2.5:3b pnpm exec tsx scripts/real-gate.ts
 */
import { openStore } from "../src/core/db/store.js";
import { recommend } from "../src/core/recommender/index.js";
import { ProviderError } from "../src/core/recommender/provider.js";
import { localProvider } from "../src/core/recommender/providers/local.js";
import type { FetchLike } from "../src/core/recommender/providers/shared.js";
import { loadConfig } from "../src/core/config.js";

interface Task {
  task: string;
  tight?: boolean;
  integrations?: string[];
}
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

const BASE_URL = "http://localhost:11434/v1";
const MODEL = process.env.CCHARNESS_GATE_MODEL ?? "qwen3:4b";

/**
 * Wrap the global fetch so each propose() call's HTTP round-trips are counted.
 * The provider makes one round-trip on the first attempt and a second only when
 * the first response was not schema-valid (the repair retry, shared.ts), so the
 * per-call count is exactly the JSON-reliability signal we want to report.
 */
function countingFetch(): { fetchImpl: FetchLike; reset: () => void; count: () => number } {
  let n = 0;
  const fetchImpl = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    n += 1;
    return fetch(input, init);
  }) as FetchLike;
  return { fetchImpl, reset: () => { n = 0; }, count: () => n };
}

interface TaskResult {
  index: number;
  task: string;
  outcome: "first-call" | "repair-retry" | "failed";
  roundTrips: number;
  lines: number;
  conflicts: number;
  costNotes: number;
  tokenBudget?: number;
  error?: string;
}

async function main(): Promise<void> {
  // REAL config + REAL synced store at the default path.
  const config = loadConfig();
  const db = openStore();

  const { fetchImpl, reset, count } = countingFetch();
  const provider = localProvider({ baseUrl: BASE_URL, model: MODEL, fetchImpl });

  console.log(`# REAL-GATE — model=${MODEL} baseUrl=${BASE_URL}`);
  console.log(`# provider=${provider.name} paid=${provider.paid}\n`);

  const results: TaskResult[] = [];

  for (let i = 0; i < TASKS.length; i++) {
    const t = TASKS[i]!;
    console.log(`\n## Task ${i + 1}: ${t.task}${t.tight ? "  [--tight]" : ""}${t.integrations ? `  [int=${t.integrations}]` : ""}`);
    reset();
    // Force a fresh model call so every task exercises the provider (no cache).
    try {
      const rec = await recommend(db, config, t.task, {
        scope: "system",
        noCache: true,
        provider,
        ...(t.tight ? { tight: true } : {}),
        ...(t.integrations ? { integrations: t.integrations } : {}),
      });
      const roundTrips = count();
      let conflicts = 0;
      let costNotes = 0;
      for (const l of rec.lines) {
        console.log(`  ${l.action.toUpperCase().padEnd(7)} ${l.componentRef.padEnd(28)} — ${l.reason}`);
      }
      for (const a of rec.annotations) {
        console.log(`  [${a.severity}/${a.kind}] ${a.message}`);
        if (a.kind === "singleton" && a.severity === "conflict") conflicts++;
        if (a.kind === "context-cost") costNotes++;
      }
      const tb = rec.contextCostSummary.tokenBudget;
      console.log(`  (roundTrips=${roundTrips} lines=${rec.lines.length} costly=${rec.contextCostSummary.costlyCount} tokenBudget=${tb ?? "n/a"})`);
      results.push({
        index: i + 1,
        task: t.task,
        outcome: roundTrips <= 1 ? "first-call" : "repair-retry",
        roundTrips,
        lines: rec.lines.length,
        conflicts,
        costNotes,
        ...(tb != null ? { tokenBudget: tb } : {}),
      });
    } catch (e) {
      const roundTrips = count();
      const msg = e instanceof Error ? e.message : String(e);
      const isProvider = e instanceof ProviderError;
      console.log(`  ${isProvider ? "PROVIDER-ERROR" : "ERROR"} (roundTrips=${roundTrips}): ${msg}`);
      results.push({ index: i + 1, task: t.task, outcome: "failed", roundTrips, lines: 0, conflicts: 0, costNotes: 0, error: msg });
    }
  }

  // Cache check — Task 1 was run above with noCache:true, so it is NOT cached.
  // Prime it once (cache write-through) then re-run; the second call must be a
  // free hit (cached=true, zero round-trips). A provider failure while priming
  // is reported, not fatal — the reliability tally below is the deliverable.
  try {
    reset();
    await recommend(db, config, TASKS[0]!.task, { scope: "system", provider });
    const primeTrips = count();
    reset();
    const cacheHit = await recommend(db, config, TASKS[0]!.task, { scope: "system", provider });
    console.log(`\n## Cache check — primed Task 1 (roundTrips=${primeTrips}) then re-ran: cached=${cacheHit.cached} roundTrips=${count()} (free hit = ${cacheHit.cached && count() === 0})`);
  } catch (e) {
    console.log(`\n## Cache check — could not prime Task 1 this run: ${e instanceof Error ? e.message : String(e)}`);
  }

  // RELIABILITY tally — the Milestone-0 step-4 finding.
  const firstCall = results.filter((r) => r.outcome === "first-call").length;
  const repaired = results.filter((r) => r.outcome === "repair-retry").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  const totalConflicts = results.reduce((a, r) => a + r.conflicts, 0);
  const totalCostNotes = results.reduce((a, r) => a + r.costNotes, 0);
  console.log(`\n# RELIABILITY model=${MODEL} tasks=${TASKS.length}`);
  console.log(`#   valid-on-first-call=${firstCall}  needed-repair-retry=${repaired}  failed=${failed}`);
  console.log(`#   singletonConflicts(total)=${totalConflicts}  contextCostNotes(total)=${totalCostNotes}`);
  console.log(`#   per-task: ${results.map((r) => `T${r.index}=${r.outcome}`).join(" ")}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
