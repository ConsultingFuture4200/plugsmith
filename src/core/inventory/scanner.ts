import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { inferCategories } from "../classify.js";
import { getComponent, replaceInventory } from "../db/components.js";
import type { DB } from "../db/store.js";
import type { InventoryItem } from "../types.js";

/**
 * Inventory scanner (PRD §4.2, Milestone B).
 *
 * Scans `~/.claude/plugins/`, `~/.claude/skills/`, project `.claude/`, and the
 * three settings files (`~/.claude/settings.json`, `.claude/settings.json`,
 * `.claude/settings.local.json`) to determine installed + enabled/disabled
 * state and scope. Best-effort: an unparseable settings file is reported in
 * `unreadable` and skipped, never fatal (PRD §8).
 *
 * Component refs mirror Claude Code's own identifiers so a recommendation can
 * round-trip to the install CLI (PRD §4.3):
 * - plugins → the `name@marketplace` key from `enabledPlugins`
 * - skills  → the skill directory name
 */
export interface ScanReport {
  items: InventoryItem[];
  unreadable: Array<{ file: string; reason: string }>;
  /**
   * Raw self-described metadata captured at scan time for items not (yet) known
   * to be in the index (PRD §4.2): a skill's SKILL.md frontmatter or a plugin's
   * plugin.json. Keyed by `componentRef`. `reconcile` turns this into the
   * `derived` annotation for out-of-index items; it is scratch, never persisted.
   */
  derivedInputs: Map<string, DerivedInput>;
}

/** Self-described metadata read from a component's own definition (PRD §4.2). */
interface DerivedInput {
  description?: string;
  /** name/keywords/tags surfaced for category inference, already merged to text. */
  signalText: string;
  source: "skill-frontmatter" | "plugin-json";
}

/**
 * Injectable filesystem roots so the scan is hermetic in tests (PRD §8). All
 * default to the operator's real machine; tests pass temp-dir paths and never
 * touch the real `~/.claude`.
 */
export interface ScanBasePaths {
  /** System-scope Claude home (default `~/.claude`). */
  claudeHome?: string;
  /** Project root whose `.claude/` is the project scope (default `opts.projectPath`). */
  projectPath?: string;
}

export interface ScanOptions {
  projectPath?: string;
  basePaths?: ScanBasePaths;
}

/** Read + JSON-parse a settings file best-effort; record failures (PRD §8). */
function readSettings(
  file: string,
  unreadable: ScanReport["unreadable"],
): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    unreadable.push({ file, reason: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    unreadable.push({ file, reason: "settings is not a JSON object" });
    return undefined;
  } catch (err) {
    unreadable.push({ file, reason: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/**
 * Pull the `enabledPlugins` map (`{ "name@marketplace": boolean }`) from a
 * parsed settings object. Tolerant: a missing/odd-shaped value yields no
 * entries rather than throwing.
 */
function enabledPlugins(settings: Record<string, unknown> | undefined): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const value = settings?.enabledPlugins;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
      out.set(key, enabled === true);
    }
  }
  return out;
}

/** List immediate child directory names under `dir`, or [] when absent. */
function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Read a skill's `SKILL.md` and extract its YAML frontmatter
 * (`name`/`description`/`tags`/`metadata`) into a `DerivedInput` (PRD §4.2).
 * Best-effort: a missing or malformed file yields `undefined` and is skipped,
 * never fatal (PRD §8). The `description` may be a folded `>` scalar, which the
 * `yaml` parser already collapses to a single string for us.
 */
function readSkillFrontmatter(skillDir: string, name: string): DerivedInput | undefined {
  const file = join(skillDir, "SKILL.md");
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  // Frontmatter is the block between the first pair of `---` fences.
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match?.[1]) return undefined;
  let fm: unknown;
  try {
    fm = parseYaml(match[1]);
  } catch {
    return undefined;
  }
  if (fm == null || typeof fm !== "object" || Array.isArray(fm)) return undefined;
  const obj = fm as Record<string, unknown>;
  const description = typeof obj.description === "string" ? obj.description.trim() : undefined;
  const fmName = typeof obj.name === "string" ? obj.name : name;
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : [];
  const signalText = [fmName, description ?? "", tags.join(" ")].join(" ").trim();
  return { ...(description ? { description } : {}), signalText, source: "skill-frontmatter" };
}

/**
 * Read installed plugin metadata for a `name@marketplace` ref from
 * `installed_plugins.json` → the plugin's `plugin.json` (PRD §4.2). Tolerant of
 * two on-disk shapes: a top-level `{ ref: [{ installPath }] }` map, or a nested
 * `{ plugins: { ref: [{ installPath }] } }` wrapper. Best-effort: any missing
 * or malformed file yields `undefined` and is skipped, never fatal (PRD §8).
 */
function readPluginMetadata(claudeHome: string, ref: string): DerivedInput | undefined {
  const manifest = join(claudeHome, "plugins", "installed_plugins.json");
  if (!existsSync(manifest)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return undefined;
  }
  if (parsed == null || typeof parsed !== "object") return undefined;
  const top = parsed as Record<string, unknown>;
  const map =
    top.plugins && typeof top.plugins === "object" && !Array.isArray(top.plugins)
      ? (top.plugins as Record<string, unknown>)
      : top;
  const entry = map[ref];
  const records = Array.isArray(entry) ? entry : entry != null ? [entry] : [];
  const first = records[0];
  const installPath =
    first && typeof first === "object" && typeof (first as Record<string, unknown>).installPath === "string"
      ? ((first as Record<string, unknown>).installPath as string)
      : undefined;
  if (installPath == null) return undefined;

  for (const candidate of [join(installPath, ".claude-plugin", "plugin.json"), join(installPath, "plugin.json")]) {
    if (!existsSync(candidate)) continue;
    let pj: unknown;
    try {
      pj = JSON.parse(readFileSync(candidate, "utf8"));
    } catch {
      return undefined;
    }
    if (pj == null || typeof pj !== "object") return undefined;
    const obj = pj as Record<string, unknown>;
    const description = typeof obj.description === "string" ? obj.description.trim() : undefined;
    const pjName = typeof obj.name === "string" ? obj.name : ref;
    const keywords = Array.isArray(obj.keywords)
      ? obj.keywords.filter((k): k is string => typeof k === "string")
      : [];
    const signalText = [pjName, description ?? "", keywords.join(" ")].join(" ").trim();
    return { ...(description ? { description } : {}), signalText, source: "plugin-json" };
  }
  return undefined;
}

/**
 * Walk the configured roots and settings files into a flat inventory snapshot.
 * Pure I/O — reconciliation against the index happens in `reconcile`.
 */
export function scanInventory(opts: ScanOptions = {}): ScanReport {
  const claudeHome = opts.basePaths?.claudeHome ?? join(homedir(), ".claude");
  const projectPath = opts.basePaths?.projectPath ?? opts.projectPath;
  const scannedAt = new Date().toISOString();
  const unreadable: ScanReport["unreadable"] = [];
  const items: InventoryItem[] = [];
  const derivedInputs: ScanReport["derivedInputs"] = new Map();

  // A plugin ref is `name@marketplace`; a skill is a bare directory name.
  const kindOf = (ref: string): "skill" | "plugin" => (ref.includes("@") ? "plugin" : "skill");

  // --- System-scope settings + plugins ---
  const systemSettingsFile = join(claudeHome, "settings.json");
  const systemSettings = readSettings(systemSettingsFile, unreadable);
  for (const [ref, enabled] of enabledPlugins(systemSettings)) {
    items.push({
      componentRef: ref,
      scope: "system",
      enabled,
      sourceFile: systemSettingsFile,
      scannedAt,
      kind: kindOf(ref),
    });
    // Capture the plugin's self-described metadata for out-of-index labelling.
    const meta = readPluginMetadata(claudeHome, ref);
    if (meta && !derivedInputs.has(ref)) derivedInputs.set(ref, meta);
  }

  // System-scope skills: a skill directory is present ⇒ installed + enabled.
  const systemSkillsDir = join(claudeHome, "skills");
  for (const name of listSubdirs(systemSkillsDir)) {
    items.push({
      componentRef: name,
      scope: "system",
      enabled: true,
      sourceFile: systemSkillsDir,
      scannedAt,
      kind: "skill",
    });
    const fm = readSkillFrontmatter(join(systemSkillsDir, name), name);
    if (fm && !derivedInputs.has(name)) derivedInputs.set(name, fm);
  }

  // --- Project-scope settings + skills ---
  if (projectPath != null) {
    const projectClaude = join(projectPath, ".claude");
    // `settings.local.json` overrides `settings.json`; later wins on the enabled flag.
    const projectEnabled = new Map<string, { enabled: boolean; sourceFile: string }>();
    for (const fileName of ["settings.json", "settings.local.json"]) {
      const file = join(projectClaude, fileName);
      const settings = readSettings(file, unreadable);
      for (const [ref, enabled] of enabledPlugins(settings)) {
        projectEnabled.set(ref, { enabled, sourceFile: file });
      }
    }
    for (const [ref, { enabled, sourceFile }] of projectEnabled) {
      items.push({
        componentRef: ref,
        scope: "project",
        projectPath,
        enabled,
        sourceFile,
        scannedAt,
        kind: kindOf(ref),
      });
      const meta = readPluginMetadata(claudeHome, ref);
      if (meta && !derivedInputs.has(ref)) derivedInputs.set(ref, meta);
    }

    const projectSkillsDir = join(projectClaude, "skills");
    for (const name of listSubdirs(projectSkillsDir)) {
      items.push({
        componentRef: name,
        scope: "project",
        projectPath,
        enabled: true,
        sourceFile: projectSkillsDir,
        scannedAt,
        kind: "skill",
      });
      const fm = readSkillFrontmatter(join(projectSkillsDir, name), name);
      if (fm && !derivedInputs.has(name)) derivedInputs.set(name, fm);
    }
  }

  return { items, unreadable, derivedInputs };
}

/**
 * Reconcile a scan against the index, annotating each item with
 * category/trust/context-cost; unknown installed items become `resolved: null`
 * ("installed, not in index") (PRD §4.2, Milestone B step 3). The annotated
 * snapshot is persisted to the `inventory` table and returned.
 *
 * For items that do NOT resolve in the index, derive a description + inferred
 * categories from the component's own definition (SKILL.md frontmatter or
 * plugin.json) so `status` can label them instead of showing a bare "not in
 * index" (PRD §4.2). The index annotation always wins when present — derived is
 * computed only for the unresolved tail and is not persisted (status re-scans
 * fresh, so it recomputes on read).
 */
export function reconcile(db: DB, report: ScanReport): InventoryItem[] {
  const annotated = report.items.map((item) => {
    const component = getComponent(db, item.componentRef);
    if (component) {
      const resolved = {
        categoryTags: component.categoryTags,
        trustTier: component.trustTier,
        contextCostFlag: component.contextCostFlag,
        ...(component.description ? { description: component.description } : {}),
        ...(component.contextTokens != null ? { contextTokens: component.contextTokens } : {}),
      };
      return { ...item, resolved };
    }

    // Not in the index: build the derived annotation from the scanned definition.
    const input = report.derivedInputs.get(item.componentRef);
    if (input) {
      const categoryTags = inferCategories(input.signalText);
      const derived: NonNullable<InventoryItem["derived"]> = {
        ...(input.description ? { description: input.description } : {}),
        categoryTags,
        source: input.source,
      };
      return { ...item, resolved: null, derived };
    }
    return { ...item, resolved: null };
  });
  replaceInventory(db, annotated);
  return annotated;
}
