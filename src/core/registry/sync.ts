import { existsSync, readFileSync } from "node:fs";
import type { CcharnessConfig, MarketplaceConfig } from "../config.js";
import { searchComponents, upsertComponents } from "../db/components.js";
import { type DB, indexVersion, setMeta } from "../db/store.js";
import type { Component } from "../types.js";
import {
  NormalizeError,
  normalizeCanonical,
  normalizeOfficial,
  resolveCategoryKey,
} from "./normalizer.js";

/**
 * Registry sync (PRD §4.1, Milestone A).
 *
 * `sync` fetches each enabled marketplace (canonical catalog primary),
 * normalizes via the adapters, upserts into `components`, and bumps the index
 * version (which invalidates `rec_cache`, PRD §4.8). Skip-loud: returns
 * per-source parsed/skipped counts; never fails the whole run for one bad entry
 * (PRD §8).
 */
export interface SyncSourceReport {
  marketplace: string;
  parsed: number;
  skipped: number;
  /** Source-level failure (fetch/parse) — the source is skipped wholesale. */
  error?: string;
}

export interface SyncReport {
  sources: SyncSourceReport[];
  newIndexVersion: string;
}

/** Derive a stable marketplace id from its configured name. */
function marketplaceId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Load a source's raw JSON. Supports `file:` URLs and bare local paths so the
 * sync path is testable offline; anything else is fetched over the network with
 * the native `fetch` (PRD §4.1).
 */
async function loadSource(gitUrl: string): Promise<unknown> {
  if (gitUrl.startsWith("http://") || gitUrl.startsWith("https://")) {
    const res = await fetch(gitUrl);
    if (!res.ok) throw new Error(`fetch ${gitUrl} → HTTP ${res.status}`);
    return (await res.json()) as unknown;
  }
  const path = gitUrl.startsWith("file:") ? new URL(gitUrl).pathname : gitUrl;
  if (!existsSync(path)) throw new Error(`source not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * Pull the list of raw entries out of a parsed source. Accepts a top-level
 * array or an object wrapping the entries under a common key (`plugins` /
 * `components` / `entries`), which is the official-marketplace shape.
 */
function extractEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["plugins", "components", "entries"] as const) {
      const value = (raw as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  throw new Error("source has no recognizable entries array");
}

/** Normalize one source's entries, skip-loud per malformed entry (PRD §8). */
function normalizeSource(
  mc: MarketplaceConfig,
  id: string,
  entries: unknown[],
): { parsed: Component[]; skipped: number } {
  const parsed: Component[] = [];
  let skipped = 0;
  for (const entry of entries) {
    try {
      const component =
        mc.kind === "official"
          ? normalizeOfficial(entry, id)
          : normalizeCanonical(entry, id, mc.trustDefault);
      parsed.push(component);
    } catch (err) {
      // Skip-loud: count it and log, never abort the source for one bad entry.
      skipped += 1;
      const reason = err instanceof NormalizeError ? err.message : String(err);
      console.error(`ccharness sync: skipped malformed entry in ${mc.name}: ${reason}`);
    }
  }
  return { parsed, skipped };
}

/** Insert/refresh the marketplace row so the components FK resolves (PRD §7). */
function upsertMarketplace(db: DB, id: string, mc: MarketplaceConfig, syncedAt: string): void {
  db.prepare(/* sql */ `
    INSERT INTO marketplaces (id, name, git_url, trust_default, kind, last_synced)
    VALUES (@id, @name, @git_url, @trust_default, @kind, @last_synced)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      git_url = excluded.git_url,
      trust_default = excluded.trust_default,
      kind = excluded.kind,
      last_synced = excluded.last_synced
  `).run({
    id,
    name: mc.name,
    git_url: mc.gitUrl,
    trust_default: mc.trustDefault,
    kind: mc.kind,
    last_synced: syncedAt,
  });
}

/**
 * Sync all enabled marketplaces into the index (PRD §4.1). Each source is
 * isolated: a fetch/parse failure or a run of malformed entries skips loudly
 * without failing the whole run. On completion the index version is bumped,
 * invalidating `rec_cache` (PRD §4.8).
 */
export async function sync(db: DB, config: CcharnessConfig): Promise<SyncReport> {
  const sources: SyncSourceReport[] = [];
  const syncedAt = new Date().toISOString();

  for (const mc of config.marketplaces) {
    if (!mc.enabled) continue;
    const id = marketplaceId(mc.name);
    try {
      const raw = await loadSource(mc.gitUrl);
      const entries = extractEntries(raw);
      const { parsed, skipped } = normalizeSource(mc, id, entries);
      const stamped = parsed.map((c) => ({ ...c, lastSynced: syncedAt }));
      upsertMarketplace(db, id, mc, syncedAt);
      upsertComponents(db, stamped);
      sources.push({ marketplace: mc.name, parsed: parsed.length, skipped });
    } catch (err) {
      // Source-level failure: skip the whole source, keep the run going.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`ccharness sync: source ${mc.name} failed: ${message}`);
      sources.push({ marketplace: mc.name, parsed: 0, skipped: 0, error: message });
    }
  }

  // Bump the index version — invalidates rec_cache (PRD §4.8). Monotonic int.
  const next = String(Number(indexVersion(db)) + 1);
  setMeta(db, "index_version", next);

  return { sources, newIndexVersion: next };
}

/** Search options for the registry query (PRD §4.1). `category` is an id or key. */
export interface SearchQueryOptions {
  category?: string;
}

/**
 * Query the index (PRD §4.1). Substring LIKE over name/description, optionally
 * narrowed by category (numeric id or taxonomy key, resolved to a key). An
 * unrecognized category yields no results rather than ignoring the filter.
 */
export function search(db: DB, query: string, opts: SearchQueryOptions = {}): Component[] {
  if (opts.category == null) return searchComponents(db, query);
  const key = resolveCategoryKey(opts.category);
  if (key == null) return [];
  return searchComponents(db, query, { category: key });
}
