import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlugsmithConfig } from "../config.js";
import { getInventory } from "../db/components.js";
import { type DB, indexVersion } from "../db/store.js";
import { reconcile, scanInventory } from "../inventory/scanner.js";
import type { InventoryItem, Recommendation, Scope } from "../types.js";

/**
 * gen-claudemd support (PRD §4.5, §6, §8, Milestone D / UMB-139/140).
 *
 * Two state-changing paths flow through here, both review-/confirm-first:
 *   1. Deriving a chosen stack and rendering/writing the managed block. The
 *      byte-safe write itself lives in `block.ts` (already unit-tested); this
 *      module only chooses *what* goes in the block and bumps the embedded
 *      version.
 *   2. The install shell-out (UMB-140): for accepted "install" lines, defer to
 *      the official `claude plugin install` — plugsmith owns recommendation, not
 *      package management (PRD §6). It never reimplements installation.
 */

/** The chosen stack a managed block is rendered from (PRD §4.5). */
export interface ChosenStack {
  /** Component refs to enable (the block's "Enabled stack" list). */
  enabled: string[];
  /** Component refs the recommendation said to install (drives UMB-140). */
  install: string[];
}

/**
 * Pure: extract the chosen stack from a validated Recommendation (PRD §4.3,
 * §4.5). `enable` and `install` lines populate the block's enabled list (an
 * install you accept becomes part of the enabled stack); `disable` lines are
 * dropped. `install` is tracked separately so the CLI can offer the UMB-140
 * shell-out for exactly those refs.
 */
export function stackFromRecommendation(rec: Recommendation): ChosenStack {
  const enabled: string[] = [];
  const install: string[] = [];
  const seen = new Set<string>();
  for (const line of rec.lines) {
    if (line.action === "disable") continue;
    if (!seen.has(line.componentRef)) {
      seen.add(line.componentRef);
      enabled.push(line.componentRef);
    }
    if (line.action === "install") install.push(line.componentRef);
  }
  return { enabled, install };
}

interface RecCacheRow {
  proposal: string;
}

/**
 * Read the most recent cached Recommendation for `task` at the current index
 * version + scope (PRD §4.8 cache keying). Returns undefined when the operator
 * has not run `recommend` for this task/scope against the live index — the CLI
 * then tells them to run it first rather than guessing a stack.
 */
export function readLatestRecommendation(
  db: DB,
  task: string,
  scope: Scope,
): Recommendation | undefined {
  const signature = taskSignature(task);
  const version = indexVersion(db);
  const row = db
    .prepare(
      "SELECT proposal FROM rec_cache WHERE task_signature = ? AND index_version = ? AND scope = ?",
    )
    .get(signature, version, scope) as RecCacheRow | undefined;
  if (!row) return undefined;
  return JSON.parse(row.proposal) as Recommendation;
}

/**
 * Cache signature for a task (PRD §4.8). MUST match the recommender's keying
 * (lowercase, whitespace-collapsed, trimmed, sha256) so a `--from-recommend`
 * lookup hits the row a prior `recommend` wrote.
 */
function taskSignature(task: string): string {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

const BLOCK_VERSION_RE = /<!--\s*plugsmith:start\s+v([\w.\-]+)\s*-->/;

/**
 * Parse the embedded version from an existing managed block, or undefined when
 * the file has no block yet (PRD §4.5). Pure.
 */
export function parseBlockVersion(content: string): string | undefined {
  const match = content.match(BLOCK_VERSION_RE);
  return match?.[1];
}

/**
 * Bump the patch component of a dotted version (PRD §4.5: "bumps the embedded
 * version"). Non-semver / unparseable input falls back to appending `.1` so a
 * regenerate always advances the version monotonically. Pure.
 */
export function bumpPatch(version: string): string {
  const parts = version.split(".");
  const last = parts[parts.length - 1];
  const n = last !== undefined ? Number.parseInt(last, 10) : Number.NaN;
  if (parts.length >= 2 && Number.isFinite(n) && String(n) === last) {
    parts[parts.length - 1] = String(n + 1);
    return parts.join(".");
  }
  return `${version}.1`;
}

/**
 * Decide the version to embed in a freshly rendered block for `path`
 * (PRD §4.5). If a block already exists, bump its patch; otherwise seed from
 * `seed` (the package/index version). Pure-ish: reads the file but writes
 * nothing.
 */
export function nextBlockVersion(path: string, seed: string): string {
  if (!existsSync(path)) return seed;
  const existing = parseBlockVersion(readFileSync(path, "utf8"));
  return existing ? bumpPatch(existing) : seed;
}

/** Result of an install shell-out attempt for one component (UMB-140). */
export interface InstallResult {
  componentRef: string;
  status: "installed" | "failed";
  /** Non-zero exit code or spawn error message when `failed`. */
  detail?: string;
}

/** Injectable spawn for tests; defaults to a real `claude` shell-out (UMB-140). */
export interface InstallRunner {
  /** Resolve the absolute path of `claude` on PATH, or undefined when absent. */
  resolve: (bin: string) => string | undefined;
  /** Run `claude plugin install <ref>`; return exit code (or null) + stderr. */
  run: (ref: string) => { code: number | null; stderr: string };
}

/**
 * Default runner: locate `claude` via the OS and shell out to its plugin
 * installer (PRD §6 — official CLI is source of truth). Inherits stdio for the
 * resolve probe but captures the install output so the CLI can report it.
 */
export const defaultInstallRunner: InstallRunner = {
  resolve(bin) {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
    });
    if (probe.status !== 0) return undefined;
    const first = probe.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first?.trim();
  },
  run(ref) {
    const result = spawnSync("claude", ["plugin", "install", ref], { encoding: "utf8" });
    if (result.error) return { code: null, stderr: result.error.message };
    return { code: result.status, stderr: result.stderr ?? "" };
  },
};

/** Raised when the install path is requested but `claude` is not on PATH (UMB-140). */
export class InstallUnavailableError extends Error {}

/**
 * Shell out to `claude plugin install` for each accepted ref, then re-run the
 * inventory scan + reconcile so the store reflects what is now installed
 * (PRD §6, UMB-140). This is a state-changing path: the CLI MUST gate it behind
 * an explicit confirm before calling. Fails clearly (throws) when `claude` is
 * not on PATH rather than guessing an install mechanism.
 */
export function installComponents(
  db: DB,
  refs: string[],
  opts: { runner?: InstallRunner; projectPath?: string } = {},
): InstallResult[] {
  const runner = opts.runner ?? defaultInstallRunner;
  if (runner.resolve("claude") === undefined) {
    throw new InstallUnavailableError(
      "install: `claude` not found on PATH. Install the official CLI first; plugsmith does not reimplement plugin installation.",
    );
  }

  const results: InstallResult[] = [];
  for (const ref of refs) {
    const { code, stderr } = runner.run(ref);
    if (code === 0) {
      results.push({ componentRef: ref, status: "installed" });
    } else {
      results.push({
        componentRef: ref,
        status: "failed",
        detail: code === null ? stderr : `exit ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      });
    }
  }

  // Re-inventory so the store reflects reality after the installs (PRD §6).
  const report = scanInventory(opts.projectPath != null ? { projectPath: opts.projectPath } : {});
  reconcile(db, report);

  return results;
}

/**
 * Current enabled inventory refs for `scope` (PRD §4.2), used when the operator
 * runs gen-claudemd without `--from-recommend`/`--components` — the block then
 * reflects what is already enabled. Reads the persisted snapshot only.
 */
export function enabledRefsFromInventory(db: DB, scope: Scope): string[] {
  const inventory: InventoryItem[] = getInventory(db);
  return inventory.filter((i) => i.scope === scope && i.enabled).map((i) => i.componentRef);
}

/**
 * Resolve the default managed-block path for a scope (PRD §4.5). System scope →
 * `~/.claude/CLAUDE.md`; project scope → `<cwd>/CLAUDE.md`. `config` is accepted
 * for future per-scope overrides; unused in v1.
 */
export function defaultClaudeMdPath(scope: Scope, _config?: PlugsmithConfig): string {
  if (scope === "system") {
    return join(homedir(), ".claude", "CLAUDE.md");
  }
  return join(process.cwd(), "CLAUDE.md");
}
