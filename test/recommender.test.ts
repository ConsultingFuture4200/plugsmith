import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { upsertComponents } from "../src/core/db/components.js";
import { type DB, openStore } from "../src/core/db/store.js";
import { recommend } from "../src/core/recommender/index.js";
import type { ModelProvider } from "../src/core/recommender/provider.js";
import { FakeProvider } from "../src/core/recommender/providers/fake.js";
import type { Component } from "../src/core/types.js";

/**
 * Keep these existing integration tests hermetic: the real hook-matcher overlay
 * (PRD §4.4) defaults to `~/.claude`, so point it at a non-existent dir. The
 * seeded components here use `@`-less fake ids that no real plugin ref matches,
 * so the overlay is a no-op for them regardless — this just avoids touching the
 * operator's machine during tests.
 */
const NO_HOOKS = { hookBasePaths: { claudeHome: "/nonexistent/plugsmith-test" } } as const;

/**
 * Milestone C integration spine (PRD §4.3, §4.4, §4.8).
 *
 * Proves the recommender pipeline wires together against a FAKE provider and a
 * hand-seeded tiny index, BEFORE the real index (A) and real providers exist:
 *   pre-filter → propose → validate → annotate → cache.
 */
function comp(over: Partial<Component> & { id: string; name: string }): Component {
  return {
    marketplaceId: "seed",
    trustTier: "community",
    description: "",
    categoryTags: [],
    bundles: { skills: [], commands: [], hooks: [], mcpServers: [] },
    contextCostFlag: false,
    singletonCategories: [],
    compatibility: [],
    ...over,
  };
}

/** ~10 components incl. two singleton 'memory' occupants and two costly MCP. */
const SEED: Component[] = [
  comp({
    id: "mem-a",
    name: "MemoryEngineA",
    categoryTags: ["memory"],
    singletonCategories: ["memory"],
    trustTier: "partner",
    description: "persistent memory plugin",
  }),
  comp({
    id: "mem-b",
    name: "MemoryEngineB",
    categoryTags: ["memory"],
    singletonCategories: ["memory"],
    trustTier: "community",
    description: "another memory plugin to remember things",
  }),
  comp({
    id: "mcp-slack",
    name: "SlackMCP",
    categoryTags: ["integrations"],
    contextCostFlag: true,
    trustTier: "partner",
    description: "slack mcp connector integration",
  }),
  comp({
    id: "mcp-gh",
    name: "GithubMCP",
    categoryTags: ["integrations"],
    contextCostFlag: true,
    trustTier: "official",
    description: "github mcp connector integration",
  }),
  comp({
    id: "test-tdd",
    name: "TddGuardrail",
    categoryTags: ["testing"],
    trustTier: "official",
    description: "tdd test coverage guardrail",
  }),
  comp({
    id: "git-flow",
    name: "GitFlow",
    categoryTags: ["git"],
    trustTier: "partner",
    description: "git commit branch workflow",
  }),
  comp({
    id: "review-bot",
    name: "ReviewBot",
    categoryTags: ["code-review"],
    trustTier: "community",
    description: "automated code review feedback",
  }),
  comp({
    id: "sec-audit",
    name: "SecAudit",
    categoryTags: ["security"],
    trustTier: "official",
    description: "security supply chain audit",
  }),
  comp({
    id: "ctx-mgr",
    name: "ContextManager",
    categoryTags: ["context-mgmt"],
    singletonCategories: ["context-mgmt"],
    trustTier: "partner",
    description: "context token window manager",
  }),
  comp({
    id: "fmt-out",
    name: "OutputStyler",
    categoryTags: ["output-styling"],
    trustTier: "community",
    description: "markdown output styling",
  }),
];

function seedMarketplace(db: DB): void {
  db.prepare(
    "INSERT INTO marketplaces (id, name, git_url, trust_default, kind) VALUES (?, ?, ?, ?, ?)",
  ).run("seed", "Seed Marketplace", "https://example.invalid/seed", "community", "custom");
}

function seedInventory(db: DB): void {
  const stmt = db.prepare(
    "INSERT INTO inventory (component_ref, scope, project_path, enabled, source_file, scanned_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  stmt.run("mem-a", "system", null, 1, "~/.claude/settings.json", now);
  stmt.run("test-tdd", "system", null, 0, "~/.claude/settings.json", now);
}

describe("recommend (Milestone C integration)", () => {
  let db: DB;

  beforeEach(() => {
    db = openStore(":memory:");
    seedMarketplace(db);
    upsertComponents(db, SEED);
    seedInventory(db);
  });

  // A task that triggers memory + testing + integrations + memory-singleton path.
  const task = "Set up persistent memory and tests with a slack and github mcp integration";

  it("drops the hallucinated line and surfaces it (PRD §4.3 step 3)", async () => {
    const provider = new FakeProvider();
    const rec = await recommend(db, DEFAULT_CONFIG, task, { provider, ...NO_HOOKS });

    // The invented component never appears in grounded lines.
    expect(rec.lines.some((l) => l.componentRef === "ghost-plugin-does-not-exist")).toBe(false);
    // But the drop is surfaced, not hidden.
    const dropped = rec.annotations.find((a) => a.message.includes("unknown component"));
    expect(dropped?.severity).toBe("warn");
    expect(dropped?.componentRefs).toContain("ghost-plugin-does-not-exist");
  });

  it("flags the two-memory singleton collision as a conflict (PRD §4.4)", async () => {
    const provider = new FakeProvider();
    const rec = await recommend(db, DEFAULT_CONFIG, task, { provider, ...NO_HOOKS });

    const conflict = rec.annotations.find((a) => a.kind === "singleton");
    expect(conflict?.severity).toBe("conflict");
    expect(conflict?.componentRefs.sort()).toEqual(["mem-a", "mem-b"]);
  });

  it("flags a singleton conflict against ENABLED inventory, not just within the proposal (PRD §4.4, §1.1)", async () => {
    // mem-a is installed + enabled (seedInventory). A provider that proposes ONLY
    // mem-b (a second memory engine) must still trip the conflict — the checker
    // reasons about the effective post-action stack, including live inventory.
    const onlyMemB: ModelProvider = {
      name: "scripted",
      paid: false,
      async propose() {
        return {
          lines: [{ action: "install", componentRef: "mem-b", reason: "second memory engine" }],
        };
      },
    };
    const rec = await recommend(db, DEFAULT_CONFIG, task, { provider: onlyMemB, ...NO_HOOKS });
    const conflict = rec.annotations.find((a) => a.kind === "singleton");
    expect(conflict?.severity).toBe("conflict");
    expect(conflict?.componentRefs.sort()).toEqual(["mem-a", "mem-b"]);
  });

  it("every grounded line resolves to a real seeded component (PRD §4.3)", async () => {
    const provider = new FakeProvider();
    const rec = await recommend(db, DEFAULT_CONFIG, task, { provider, ...NO_HOOKS });

    const known = new Set(SEED.map((c) => c.id));
    expect(rec.lines.length).toBeGreaterThan(0);
    for (const line of rec.lines) {
      expect(known.has(line.componentRef)).toBe(true);
    }
  });

  it("returns cached:true on an identical re-run with no new provider call (PRD §4.8)", async () => {
    const provider = new FakeProvider();
    const first = await recommend(db, DEFAULT_CONFIG, task, { provider, ...NO_HOOKS });
    expect(first.cached).toBe(false);
    expect(provider.calls).toBe(1);

    const second = await recommend(db, DEFAULT_CONFIG, task, { provider, ...NO_HOOKS });
    expect(second.cached).toBe(true);
    expect(provider.calls).toBe(1); // no new model call
    expect(second.lines).toEqual(first.lines);
  });

  it("--no-cache forces a fresh provider call (PRD §4.8)", async () => {
    const provider = new FakeProvider();
    await recommend(db, DEFAULT_CONFIG, task, { provider, ...NO_HOOKS });
    await recommend(db, DEFAULT_CONFIG, task, { provider, noCache: true, ...NO_HOOKS });
    expect(provider.calls).toBe(2);
  });
});
