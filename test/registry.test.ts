import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { getAllComponents } from "../src/core/db/components.js";
import { type DB, indexVersion, openStore } from "../src/core/db/store.js";
import {
  NormalizeError,
  normalizeCanonical,
  normalizeOfficial,
} from "../src/core/registry/normalizer.js";
import { search, sync } from "../src/core/registry/sync.js";

describe("normalizeCanonical (PRD §4.1)", () => {
  it("maps frontmatter and derives categories + context-cost from an MCP bundle", () => {
    const raw = {
      name: "metrc-connector",
      description: "Metrc API integration",
      "allowed-tools": ["mcp__metrc__list", "mcp__metrc__get"],
      version: "1.2.0",
      author: "umb",
      license: "MIT",
      compatibility: ["claude-code"],
      tags: ["mcp", "integration"],
      bundles: { mcpServers: ["metrc"], skills: ["metrc-skill"] },
    };
    const c = normalizeCanonical(raw, "canonical", "partner");
    expect(c.id).toBe("canonical:metrc-connector");
    expect(c.trustTier).toBe("partner");
    expect(c.categoryTags).toEqual(["integrations"]);
    expect(c.contextCostFlag).toBe(true); // MCP server present
    expect(c.bundles.mcpServers).toEqual(["metrc"]);
    expect(c.bundles.hooks).toEqual([]); // catalog declares no hooks
    expect(c.allowedTools).toHaveLength(2);
    expect(c.version).toBe("1.2.0");
  });

  it("derives singletonCategories when tags land in a singleton category", () => {
    const raw = { name: "recall", tags: ["memory", "persistence"] };
    const c = normalizeCanonical(raw, "canonical", "community");
    expect(c.categoryTags).toEqual(["memory"]);
    expect(c.singletonCategories).toEqual(["memory"]); // memory is a singleton
    expect(c.contextCostFlag).toBe(false); // lazily-loaded skill, no MCP/hook
  });

  it("flags context-cost when allowed-tools breadth is large", () => {
    const raw = {
      name: "broad-tool",
      tags: ["domain"],
      "allowed-tools": Array.from({ length: 10 }, (_, i) => `tool${i}`),
    };
    const c = normalizeCanonical(raw, "canonical", "community");
    expect(c.contextCostFlag).toBe(true);
  });

  it("drops unrecognized tags rather than inventing a category", () => {
    const c = normalizeCanonical(
      { name: "x", tags: ["totally-unknown"] },
      "canonical",
      "community",
    );
    expect(c.categoryTags).toEqual([]);
  });

  it("throws NormalizeError on a malformed entry (missing name)", () => {
    expect(() => normalizeCanonical({ description: "no name" }, "canonical", "community")).toThrow(
      NormalizeError,
    );
    expect(() => normalizeCanonical(null, "canonical", "community")).toThrow(NormalizeError);
  });
});

describe("normalizeOfficial (PRD §4.1)", () => {
  it("fixes trust to official and reads tags from category/keywords", () => {
    const c = normalizeOfficial(
      { name: "gh-tools", category: "git", keywords: ["review"] },
      "official",
    );
    expect(c.trustTier).toBe("official");
    expect(c.categoryTags.sort()).toEqual(["code-review", "git"]);
    expect(c.bundles.hooks).toEqual([]);
    expect(c.contextCostFlag).toBe(false);
  });

  it("throws NormalizeError when name is missing", () => {
    expect(() => normalizeOfficial({ category: "git" }, "official")).toThrow(NormalizeError);
  });
});

describe("sync + search (PRD §4.1, §8)", () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccharness-sync-"));
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
});
