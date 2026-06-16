import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * Walk the configured roots and settings files into a flat inventory snapshot.
 * Pure I/O — reconciliation against the index happens in `reconcile`.
 */
export function scanInventory(opts: ScanOptions = {}): ScanReport {
  const claudeHome = opts.basePaths?.claudeHome ?? join(homedir(), ".claude");
  const projectPath = opts.basePaths?.projectPath ?? opts.projectPath;
  const scannedAt = new Date().toISOString();
  const unreadable: ScanReport["unreadable"] = [];
  const items: InventoryItem[] = [];

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
    });
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
    });
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
      });
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
      });
    }
  }

  return { items, unreadable };
}

/**
 * Reconcile a scan against the index, annotating each item with
 * category/trust/context-cost; unknown installed items become `resolved: null`
 * ("installed, not in index") (PRD §4.2, Milestone B step 3). The annotated
 * snapshot is persisted to the `inventory` table and returned.
 */
export function reconcile(db: DB, report: ScanReport): InventoryItem[] {
  const annotated = report.items.map((item) => {
    const component = getComponent(db, item.componentRef);
    const resolved = component
      ? {
          categoryTags: component.categoryTags,
          trustTier: component.trustTier,
          contextCostFlag: component.contextCostFlag,
        }
      : null;
    return { ...item, resolved };
  });
  replaceInventory(db, annotated);
  return annotated;
}
