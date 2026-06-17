import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInventory, upsertComponents } from "../src/core/db/components.js";
import { type DB, openStore } from "../src/core/db/store.js";
import { reconcile, scanInventory } from "../src/core/inventory/scanner.js";
import type { Component } from "../src/core/types.js";

/**
 * Hermetic inventory tests (PRD §4.2, §8). A temp-dir tree stands in for the
 * real `~/.claude` and a project `.claude/`; nothing here reads the operator's
 * machine. One settings file is deliberately malformed to prove best-effort.
 */

/** Build a fake claudeHome + project tree under a fresh temp dir. */
function buildTree(root: string): { claudeHome: string; projectPath: string } {
  const claudeHome = join(root, "claude-home");
  const projectPath = join(root, "project");

  // System scope: settings.json with enabledPlugins, plus two skill dirs.
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify({
      enabledPlugins: {
        "neo@parslee-marketplace": true,
        "vercel@official": false,
      },
    }),
  );
  mkdirSync(join(claudeHome, "skills", "batch"), { recursive: true });
  mkdirSync(join(claudeHome, "skills", "deep-research"), { recursive: true });

  // Project scope: settings.json + settings.local.json (local overrides enabled),
  // plus one project skill dir.
  const projectClaude = join(projectPath, ".claude");
  mkdirSync(projectClaude, { recursive: true });
  writeFileSync(
    join(projectClaude, "settings.json"),
    JSON.stringify({ enabledPlugins: { "team-skill@umb": true } }),
  );
  // settings.local.json flips team-skill off and is intentionally malformed-free.
  writeFileSync(
    join(projectClaude, "settings.local.json"),
    JSON.stringify({ enabledPlugins: { "team-skill@umb": false } }),
  );
  mkdirSync(join(projectClaude, "skills", "local-skill"), { recursive: true });

  return { claudeHome, projectPath };
}

/** Seed the parent marketplace row so component FK inserts succeed. */
function seedMarketplace(db: DB): void {
  db.prepare(
    "INSERT OR IGNORE INTO marketplaces (id, name, git_url, trust_default, kind) VALUES (?, ?, ?, ?, ?)",
  ).run("parslee-marketplace", "parslee", "file:none", "partner", "custom");
}

/** A minimal index component for reconcile annotation. */
function seedComponent(over: Partial<Component> = {}): Component {
  return {
    id: "neo@parslee-marketplace",
    name: "neo",
    marketplaceId: "parslee-marketplace",
    trustTier: "partner",
    categoryTags: ["multi-agent"],
    bundles: { skills: [], commands: [], hooks: [], mcpServers: [] },
    contextCostFlag: true,
    singletonCategories: [],
    compatibility: [],
    ...over,
  };
}

describe("scanInventory (PRD §4.2, §8)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plugsmith-inv-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers system + project plugins and skills with enabled state and scope", () => {
    const { claudeHome, projectPath } = buildTree(root);
    const report = scanInventory({ basePaths: { claudeHome, projectPath } });

    expect(report.unreadable).toEqual([]);

    const byRef = new Map(report.items.map((i) => [`${i.scope}:${i.componentRef}`, i]));

    // System plugins reflect the enabledPlugins boolean.
    expect(byRef.get("system:neo@parslee-marketplace")?.enabled).toBe(true);
    expect(byRef.get("system:vercel@official")?.enabled).toBe(false);
    // System skills: present ⇒ enabled.
    expect(byRef.get("system:batch")?.enabled).toBe(true);
    expect(byRef.get("system:deep-research")?.enabled).toBe(true);

    // Project plugin: settings.local.json override wins (disabled).
    const teamSkill = byRef.get("project:team-skill@umb");
    expect(teamSkill?.enabled).toBe(false);
    expect(teamSkill?.projectPath).toBe(projectPath);
    expect(teamSkill?.scope).toBe("project");
    // Project skill discovered too.
    expect(byRef.get("project:local-skill")?.enabled).toBe(true);
  });

  it("is best-effort: a malformed settings file is reported, not fatal", () => {
    const claudeHome = join(root, "claude-home");
    mkdirSync(join(claudeHome, "skills", "ok-skill"), { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), "{ this is : not json ");

    const report = scanInventory({ basePaths: { claudeHome } });

    // The bad file is reported...
    expect(report.unreadable).toHaveLength(1);
    expect(report.unreadable[0]?.file).toBe(join(claudeHome, "settings.json"));
    // ...and the scan still surfaces what IS readable (the skill dir).
    expect(report.items.map((i) => i.componentRef)).toContain("ok-skill");
  });

  it("returns empty (no throw) when nothing exists", () => {
    const report = scanInventory({ basePaths: { claudeHome: join(root, "nope") } });
    expect(report.items).toEqual([]);
    expect(report.unreadable).toEqual([]);
  });
});

describe("reconcile (PRD §4.2, Milestone B step 3)", () => {
  let db: DB;
  let root: string;

  beforeEach(() => {
    db = openStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "plugsmith-inv-"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("annotates known items from the index and marks unknowns 'not in index'", () => {
    seedMarketplace(db);
    upsertComponents(db, [seedComponent()]);
    const { claudeHome, projectPath } = buildTree(root);

    const report = scanInventory({ basePaths: { claudeHome, projectPath } });
    const items = reconcile(db, report);

    const known = items.find((i) => i.componentRef === "neo@parslee-marketplace");
    expect(known?.resolved).toEqual({
      categoryTags: ["multi-agent"],
      trustTier: "partner",
      contextCostFlag: true,
    });

    // A discovered item absent from the index ⇒ resolved: null.
    const unknown = items.find((i) => i.componentRef === "batch");
    expect(unknown?.resolved).toBeNull();
  });

  it("persists the snapshot to the inventory table (resolved not persisted)", () => {
    seedMarketplace(db);
    upsertComponents(db, [seedComponent()]);
    const { claudeHome, projectPath } = buildTree(root);

    reconcile(db, scanInventory({ basePaths: { claudeHome, projectPath } }));

    const persisted = getInventory(db);
    expect(persisted.length).toBeGreaterThan(0);
    const neo = persisted.find((i) => i.componentRef === "neo@parslee-marketplace");
    expect(neo?.enabled).toBe(true);
    expect(neo?.scope).toBe("system");
    // getInventory does not rehydrate resolved (index-join is recomputed on read).
    expect(neo?.resolved).toBeUndefined();
  });

  it("replaceInventory clears stale rows on rescan", () => {
    const { claudeHome } = buildTree(root);
    reconcile(db, scanInventory({ basePaths: { claudeHome } }));
    const first = getInventory(db).length;
    expect(first).toBeGreaterThan(0);

    // Rescan an empty tree: snapshot should be wiped, not accumulated.
    reconcile(db, scanInventory({ basePaths: { claudeHome: join(root, "empty") } }));
    expect(getInventory(db)).toEqual([]);
  });
});

/**
 * Derived metadata for out-of-index components (PRD §4.2). A skill carries a
 * folded-scalar `description` in its SKILL.md frontmatter; the scan must capture
 * it and `reconcile` must turn it into `derived` (description + inferred
 * categories) for items not in the index, while index-resolved items keep their
 * authoritative index annotation untouched.
 */
describe("derived metadata for not-in-index components (PRD §4.2)", () => {
  let db: DB;
  let root: string;

  beforeEach(() => {
    db = openStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "plugsmith-derived-"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a SKILL.md with folded-scalar frontmatter under claudeHome/skills/<name>. */
  function writeSkill(claudeHome: string, name: string, description: string): void {
    const dir = join(claudeHome, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: >\n  ${description}\ntags: [knowledge]\n---\n\n# ${name}\n`,
    );
  }

  it("captures a folded-scalar description and kind at scan time", () => {
    const claudeHome = join(root, "claude-home");
    mkdirSync(claudeHome, { recursive: true });
    writeSkill(claudeHome, "vault", "Capture session knowledge into the Obsidian vault as notes.");

    const report = scanInventory({ basePaths: { claudeHome } });

    const item = report.items.find((i) => i.componentRef === "vault");
    expect(item?.kind).toBe("skill");

    const input = report.derivedInputs.get("vault");
    expect(input?.source).toBe("skill-frontmatter");
    // The folded `>` scalar collapses to a single line — no leading/trailing noise.
    expect(input?.description).toBe(
      "Capture session knowledge into the Obsidian vault as notes.",
    );
  });

  it("reconcile derives categories for a not-in-index skill, in-index item keeps its annotation", () => {
    seedMarketplace(db);
    // 'neo@parslee-marketplace' is in the index; the 'vault' skill is not.
    upsertComponents(db, [seedComponent()]);
    const claudeHome = join(root, "claude-home");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ enabledPlugins: { "neo@parslee-marketplace": true } }),
    );
    writeSkill(claudeHome, "vault", "Capture session knowledge and memory into the vault.");

    const items = reconcile(db, scanInventory({ basePaths: { claudeHome } }));

    // In-index item: index annotation preserved, no derived block.
    const neo = items.find((i) => i.componentRef === "neo@parslee-marketplace");
    expect(neo?.resolved).toEqual({
      categoryTags: ["multi-agent"],
      trustTier: "partner",
      contextCostFlag: true,
    });
    expect(neo?.derived).toBeUndefined();

    // Out-of-index skill: derived description + inferred categories.
    const vault = items.find((i) => i.componentRef === "vault");
    expect(vault?.resolved).toBeNull();
    expect(vault?.kind).toBe("skill");
    expect(vault?.derived?.source).toBe("skill-frontmatter");
    expect(vault?.derived?.categoryTags).toContain("memory");
    expect(vault?.derived?.description).toContain("session knowledge");
  });

  it("skips a missing/malformed SKILL.md without failing the scan", () => {
    const claudeHome = join(root, "claude-home");
    // Skill dir with no SKILL.md, and one with malformed frontmatter.
    mkdirSync(join(claudeHome, "skills", "no-md"), { recursive: true });
    const bad = join(claudeHome, "skills", "bad-md");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "SKILL.md"), "---\nname: [unterminated\n---\n");

    const report = scanInventory({ basePaths: { claudeHome } });

    // Both dirs are still discovered as items; neither yields a derived input.
    expect(report.items.map((i) => i.componentRef)).toEqual(
      expect.arrayContaining(["no-md", "bad-md"]),
    );
    expect(report.derivedInputs.has("no-md")).toBe(false);
    expect(report.derivedInputs.has("bad-md")).toBe(false);
    expect(report.unreadable).toEqual([]);
  });
});
