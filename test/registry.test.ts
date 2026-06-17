import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { getAllComponents } from "../src/core/db/components.js";
import { type DB, indexVersion, openStore } from "../src/core/db/store.js";
import { getComponent } from "../src/core/db/components.js";
import {
  NormalizeError,
  normalizeCanonical,
  normalizeLocalCache,
  normalizeOfficial,
} from "../src/core/registry/normalizer.js";
import { search, sync } from "../src/core/registry/sync.js";

describe("normalizeCanonical — extended catalog real shape (PRD §4.1)", () => {
  // One entry of the REAL `marketplace.extended.json` `plugins` ARRAY: a single
  // `category` string, a rich `keywords` array, an OBJECT `author`, and a
  // `components` object of INTEGER COUNTS (NOT name lists). See
  // docs/milestone-0-findings.md §3.
  it("uses the <name>@<marketplace> id and maps category + keywords to categories", () => {
    const raw = {
      name: "db-migrator",
      description: "Database migration helper",
      version: "2.0.0",
      category: "database",
      keywords: ["database", "testing", "ci"],
      author: { name: "Jeremy Longshore", email: "x@y.z" },
      license: "MIT",
      components: { skills: 1, commands: 1 }, // INTEGER counts, not names
    };
    const c = normalizeCanonical(raw, "canonical-catalog", "partner");
    expect(c.id).toBe("db-migrator@canonical-catalog"); // @-form, not ":"
    expect(c.trustTier).toBe("partner");
    // database → integrations; testing + ci → testing (keyword-driven precision).
    expect(c.categoryTags.sort()).toEqual(["integrations", "testing"]);
    expect(c.author).toBe("Jeremy Longshore"); // pulled from the object
    expect(c.version).toBe("2.0.0");
    expect(c.license).toBe("MIT");
    expect(c.contextTokens).toBeUndefined(); // no token costs in this source
  });

  it("never invents hooks/mcp from integer counts (no fake collisions)", () => {
    const raw = {
      name: "hooky",
      category: "devops",
      keywords: ["deployment"],
      components: { hooks: 9, total: 16 }, // integer counts only
      mcpTools: 4, // integer count, NOT a server list
    };
    const c = normalizeCanonical(raw, "canonical-catalog", "partner");
    expect(c.bundles.hooks).toEqual([]); // no event names → no hooks
    expect(c.bundles.mcpServers).toEqual([]); // integer mcpTools is ignored
    expect(c.bundles.skills).toEqual([]);
    expect(c.bundles.commands).toEqual([]);
  });

  it("populates mcpServers only when a real string[] is present", () => {
    const c = normalizeCanonical(
      { name: "real-mcp", category: "mcp", mcpTools: ["server-a", "server-b"] },
      "canonical-catalog",
      "partner",
    );
    expect(c.bundles.mcpServers).toEqual(["server-a", "server-b"]);
    expect(c.contextCostFlag).toBe(true); // MCP server present → costly
  });

  it("derives singletonCategories when keywords land in a singleton category", () => {
    const c = normalizeCanonical(
      { name: "recall", category: "memory", keywords: ["persistence"] },
      "canonical-catalog",
      "community",
    );
    expect(c.categoryTags).toEqual(["memory"]);
    expect(c.singletonCategories).toEqual(["memory"]); // memory is a singleton
    expect(c.contextCostFlag).toBe(false); // no MCP/hook, no token costs
  });

  it("drops unrecognized keywords rather than inventing a category", () => {
    const c = normalizeCanonical(
      { name: "x", category: "totally-unknown", keywords: ["also-unknown"] },
      "canonical-catalog",
      "community",
    );
    expect(c.categoryTags).toEqual([]);
  });

  it("throws NormalizeError on a malformed entry (missing name)", () => {
    expect(() =>
      normalizeCanonical({ description: "no name" }, "canonical-catalog", "community"),
    ).toThrow(NormalizeError);
    expect(() => normalizeCanonical(null, "canonical-catalog", "community")).toThrow(NormalizeError);
  });
});

describe("normalizeOfficial (PRD §4.1)", () => {
  it("fixes trust to official and reads tags from category/keywords", () => {
    const c = normalizeOfficial(
      { name: "gh-tools", category: "git", keywords: ["review"] },
      "official",
    );
    // @-form id matches the installed-plugin ref so `status` can resolve it.
    expect(c.id).toBe("gh-tools@official");
    expect(c.trustTier).toBe("official");
    expect(c.categoryTags.sort()).toEqual(["code-review", "git"]);
    expect(c.bundles.hooks).toEqual([]);
    expect(c.contextCostFlag).toBe(false);
  });

  it("throws NormalizeError when name is missing", () => {
    expect(() => normalizeOfficial({ category: "git" }, "official")).toThrow(NormalizeError);
  });
});

describe("normalizeLocalCache (PRD §4.1, Milestone A/B)", () => {
  const REF_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6"];

  function entry(over: Record<string, unknown> = {}) {
    return {
      plugin: "demo-plugin",
      tokens: {
        "claude-opus-4-7": { always_on: 1216, on_invoke: 23647 },
        "claude-sonnet-4-6": { always_on: 899, on_invoke: 17632 },
      },
      components: {
        commands: [{ name: "demo-cmd", chars: { always_on: 10, on_invoke: 20 } }],
        agents: [],
        skills: [{ name: "demo-skill", chars: { always_on: 5, on_invoke: 9 } }],
        hooks: [],
        mcpServers: [],
        lspServers: [],
      },
      unique_installs: 10,
      last_updated: "2026-06-12T10:45:37-07:00",
      marketplace_entry: {
        name: "demo-plugin",
        description: "demo description",
        category: "security",
      },
      version: "1.6.3",
      ...over,
    };
  }

  it("sets id to the full @-key, not the bare plugin name (Milestone B reconciliation)", () => {
    const c = normalizeLocalCache(entry(), {
      key: "demo-plugin@claude-plugins-official",
      trustDefault: "community",
      refModels: REF_MODELS,
    });
    expect(c.id).toBe("demo-plugin@claude-plugins-official");
    expect(c.name).toBe("demo-plugin");
    expect(c.marketplaceId).toBe("claude-plugins-official");
    expect(c.trustTier).toBe("official"); // anthropic-managed marketplace
  });

  it("takes contextTokens from the ref model's always_on and maps tags", () => {
    const c = normalizeLocalCache(entry(), {
      key: "demo-plugin@canonical-catalog",
      trustDefault: "community",
      refModels: REF_MODELS,
    });
    expect(c.contextTokens).toBe(1216); // first ref model always_on
    expect(c.trustTier).toBe("partner"); // canonical source
    expect(c.categoryTags).toEqual(["security"]); // category mapped via TAG_TO_CATEGORY
    expect(c.bundles.commands).toEqual(["demo-cmd"]);
    expect(c.bundles.skills).toEqual(["demo-skill"]);
  });

  it("flags context-cost when always-on tokens meet the threshold (>=1500)", () => {
    const costly = normalizeLocalCache(
      entry({ tokens: { "claude-opus-4-7": { always_on: 1600, on_invoke: 100 } } }),
      { key: "demo-plugin@other", trustDefault: "community", refModels: REF_MODELS },
    );
    expect(costly.contextTokens).toBe(1600);
    expect(costly.contextCostFlag).toBe(true); // 1600 >= 1500 threshold
  });

  it("light when below the token threshold and no MCP/hook", () => {
    const c = normalizeLocalCache(
      entry({
        tokens: {
          "claude-opus-4-7": { always_on: 800, on_invoke: 100 },
        },
      }),
      { key: "demo-plugin@other", trustDefault: "community", refModels: REF_MODELS },
    );
    expect(c.contextTokens).toBe(800);
    expect(c.contextCostFlag).toBe(false); // 800 < 1500, no MCP, no hook
  });

  it("treats an MCP server as context-costly regardless of tokens", () => {
    const c = normalizeLocalCache(
      entry({
        tokens: { "claude-opus-4-7": { always_on: 50, on_invoke: 10 } },
        components: {
          commands: [],
          skills: [],
          hooks: [],
          mcpServers: ["demo-server"],
          lspServers: [],
        },
      }),
      { key: "demo-plugin@other", trustDefault: "community", refModels: REF_MODELS },
    );
    expect(c.bundles.mcpServers).toEqual(["demo-server"]);
    expect(c.contextCostFlag).toBe(true);
  });

  it("maps bare event-name string hooks best-effort without throwing", () => {
    const c = normalizeLocalCache(
      entry({
        components: {
          commands: [],
          skills: [],
          hooks: ["PreToolUse", "SessionStart"],
          mcpServers: [],
          lspServers: [],
        },
      }),
      { key: "demo-plugin@other", trustDefault: "community", refModels: REF_MODELS },
    );
    expect(c.bundles.hooks).toEqual([{ event: "PreToolUse" }, { event: "SessionStart" }]);
  });

  it("falls back to the largest always_on when no ref model matches", () => {
    const c = normalizeLocalCache(entry(), {
      key: "demo-plugin@other",
      trustDefault: "community",
      refModels: ["nonexistent-model"],
    });
    expect(c.contextTokens).toBe(1216); // largest always_on present
  });

  it("throws NormalizeError on a malformed entry (missing plugin)", () => {
    expect(() =>
      normalizeLocalCache(
        { tokens: {}, components: {} },
        { key: "x@official", trustDefault: "community", refModels: REF_MODELS },
      ),
    ).toThrow(NormalizeError);
  });

  it("throws NormalizeError on a key without @marketplace", () => {
    expect(() =>
      normalizeLocalCache(entry(), {
        key: "no-marketplace",
        trustDefault: "community",
        refModels: REF_MODELS,
      }),
    ).toThrow(NormalizeError);
  });
});

describe("sync + search (PRD §4.1, §8)", () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plugsmith-sync-"));
    db = openStore(":memory:");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skip-loud: counts parsed vs skipped and bumps index version", async () => {
    const fixture = join(dir, "catalog.json");
    writeFileSync(
      fixture,
      JSON.stringify([
        { name: "mem-engine", tags: ["memory"], description: "persistent memory" },
        { name: "ctx-mgr", tags: ["context"], description: "context manager" },
        { description: "malformed: no name" }, // must be skipped-loud
      ]),
    );

    const config = {
      ...loadConfig(),
      marketplaces: [
        {
          name: "test-catalog",
          gitUrl: fixture,
          kind: "canonical" as const,
          trustDefault: "partner" as const,
          enabled: true,
        },
      ],
    };

    const before = indexVersion(db);
    const report = await sync(db, config);

    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.parsed).toBe(2);
    expect(report.sources[0]?.skipped).toBe(1);
    expect(report.newIndexVersion).not.toBe(before);
    expect(Number(report.newIndexVersion)).toBe(Number(before) + 1);

    const all = getAllComponents(db);
    expect(all.map((c) => c.name).sort()).toEqual(["ctx-mgr", "mem-engine"]);
    expect(all.every((c) => c.lastSynced != null)).toBe(true);
    // Array-shaped canonical source: ids take the <name>@<marketplace> form.
    expect(all.map((c) => c.id).sort()).toEqual([
      "ctx-mgr@test-catalog",
      "mem-engine@test-catalog",
    ]);
  });

  it("search filters by category key and numeric id", async () => {
    const fixture = join(dir, "catalog.json");
    writeFileSync(
      fixture,
      JSON.stringify([
        { name: "mem-engine", tags: ["memory"], description: "persistent memory" },
        { name: "ctx-mgr", tags: ["context"], description: "context manager" },
      ]),
    );
    const config = {
      ...loadConfig(),
      marketplaces: [
        {
          name: "test-catalog",
          gitUrl: fixture,
          kind: "canonical" as const,
          trustDefault: "partner" as const,
          enabled: true,
        },
      ],
    };
    await sync(db, config);

    expect(search(db, "memory").map((c) => c.name)).toEqual(["mem-engine"]);
    // category 3 == memory key
    expect(search(db, "e", { category: "3" }).map((c) => c.name)).toEqual(["mem-engine"]);
    expect(search(db, "e", { category: "memory" }).map((c) => c.name)).toEqual(["mem-engine"]);
    // unrecognized category yields no results
    expect(search(db, "e", { category: "nope" })).toEqual([]);
  });

  it("does not fail the whole run when one source is unreachable", async () => {
    const config = {
      ...loadConfig(),
      marketplaces: [
        {
          name: "missing",
          gitUrl: join(dir, "does-not-exist.json"),
          kind: "canonical" as const,
          trustDefault: "partner" as const,
          enabled: true,
        },
      ],
    };
    const report = await sync(db, config);
    expect(report.sources[0]?.error).toBeDefined();
    expect(report.newIndexVersion).toBeDefined();
  });

  it("ingests a local-cache fixture, persists contextTokens, and keys by @-id (PRD §4.1)", async () => {
    const fixture = join(dir, "plugin-catalog-cache.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        version: 1,
        fetchedAt: "2026-06-12T00:00:00Z",
        catalog: {
          generated_at: "2026-06-12T00:00:00Z",
          marketplace_sha: "abc",
          models: ["claude-opus-4-7", "claude-sonnet-4-6"],
          plugins: {
            "sec-plugin@claude-plugins-official": {
              plugin: "sec-plugin",
              tokens: {
                "claude-opus-4-7": { always_on: 1600, on_invoke: 9000 },
                "claude-sonnet-4-6": { always_on: 1200, on_invoke: 7000 },
              },
              components: { commands: [], agents: [], skills: [], hooks: [], mcpServers: [], lspServers: [] },
              marketplace_entry: { name: "sec-plugin", description: "security tooling", category: "security" },
              version: "2.0.0",
            },
            "bad-entry@claude-plugins-official": {
              // malformed: no plugin name → must be skipped-loud
              tokens: {},
              components: {},
            },
          },
        },
      }),
    );

    const config = {
      ...loadConfig(),
      marketplaces: [
        {
          name: "local-cli-cache",
          gitUrl: fixture,
          kind: "local-cache" as const,
          trustDefault: "community" as const,
          enabled: true,
        },
      ],
    };

    const report = await sync(db, config);
    expect(report.sources[0]?.parsed).toBe(1);
    expect(report.sources[0]?.skipped).toBe(1);

    const all = getAllComponents(db);
    expect(all.map((c) => c.id)).toEqual(["sec-plugin@claude-plugins-official"]);

    // contextTokens persisted and reads back from the index.
    const stored = getComponent(db, "sec-plugin@claude-plugins-official");
    expect(stored?.contextTokens).toBe(1600);
    expect(stored?.contextCostFlag).toBe(true); // 1600 >= 1500
    expect(stored?.trustTier).toBe("official");
    expect(stored?.marketplaceId).toBe("claude-plugins-official");
    expect(stored?.categoryTags).toEqual(["security"]);
  });
});
