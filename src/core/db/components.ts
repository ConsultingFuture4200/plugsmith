import type { Component, ComponentBundles, InventoryItem, Scope, TrustTier } from "../types.js";
import type { DB } from "./store.js";

/**
 * Repository layer over the `components` table (PRD §7, §4.1).
 *
 * The index is the source of truth the recommender grounds against (PRD §4.3),
 * so reads here back the pre-filter and validation stages. The json columns
 * (category_tags, bundles, singleton_categories, compatibility, allowed_tools)
 * are encoded on write and decoded on read into the strongly-typed Component
 * shape — callers never see raw json.
 */

/** Raw row shape as stored in SQLite (json columns are TEXT). */
interface ComponentRow {
  id: string;
  name: string;
  marketplace_id: string;
  trust_tier: string;
  description: string | null;
  category_tags: string;
  bundles: string;
  context_cost_flag: number;
  singleton_categories: string;
  compatibility: string;
  allowed_tools: string | null;
  version: string | null;
  author: string | null;
  license: string | null;
  last_synced: string | null;
}

const EMPTY_BUNDLES: ComponentBundles = {
  skills: [],
  commands: [],
  hooks: [],
  mcpServers: [],
};

/** Decode a stored row into the typed Component (PRD §4.1 index model). */
function rowToComponent(row: ComponentRow): Component {
  const component: Component = {
    id: row.id,
    name: row.name,
    marketplaceId: row.marketplace_id,
    trustTier: row.trust_tier as TrustTier,
    categoryTags: JSON.parse(row.category_tags) as string[],
    bundles: { ...EMPTY_BUNDLES, ...(JSON.parse(row.bundles) as Partial<ComponentBundles>) },
    contextCostFlag: row.context_cost_flag !== 0,
    singletonCategories: JSON.parse(row.singleton_categories) as string[],
    compatibility: JSON.parse(row.compatibility) as string[],
  };
  if (row.description != null) component.description = row.description;
  if (row.allowed_tools != null) component.allowedTools = JSON.parse(row.allowed_tools) as string[];
  if (row.version != null) component.version = row.version;
  if (row.author != null) component.author = row.author;
  if (row.license != null) component.license = row.license;
  if (row.last_synced != null) component.lastSynced = row.last_synced;
  return component;
}

/**
 * Idempotently upsert components into the index (PRD §4.1). Json columns are
 * encoded here; the call is wrapped in a single transaction so a partial batch
 * never lands.
 */
export function upsertComponents(db: DB, components: Component[]): void {
  const stmt = db.prepare(/* sql */ `
    INSERT INTO components (
      id, name, marketplace_id, trust_tier, description,
      category_tags, bundles, context_cost_flag, singleton_categories,
      compatibility, allowed_tools, version, author, license, last_synced
    ) VALUES (
      @id, @name, @marketplace_id, @trust_tier, @description,
      @category_tags, @bundles, @context_cost_flag, @singleton_categories,
      @compatibility, @allowed_tools, @version, @author, @license, @last_synced
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      marketplace_id = excluded.marketplace_id,
      trust_tier = excluded.trust_tier,
      description = excluded.description,
      category_tags = excluded.category_tags,
      bundles = excluded.bundles,
      context_cost_flag = excluded.context_cost_flag,
      singleton_categories = excluded.singleton_categories,
      compatibility = excluded.compatibility,
      allowed_tools = excluded.allowed_tools,
      version = excluded.version,
      author = excluded.author,
      license = excluded.license,
      last_synced = excluded.last_synced
  `);

  const tx = db.transaction((rows: Component[]) => {
    for (const c of rows) {
      stmt.run({
        id: c.id,
        name: c.name,
        marketplace_id: c.marketplaceId,
        trust_tier: c.trustTier,
        description: c.description ?? null,
        category_tags: JSON.stringify(c.categoryTags),
        bundles: JSON.stringify(c.bundles),
        context_cost_flag: c.contextCostFlag ? 1 : 0,
        singleton_categories: JSON.stringify(c.singletonCategories),
        compatibility: JSON.stringify(c.compatibility),
        allowed_tools: c.allowedTools ? JSON.stringify(c.allowedTools) : null,
        version: c.version ?? null,
        author: c.author ?? null,
        license: c.license ?? null,
        last_synced: c.lastSynced ?? null,
      });
    }
  });
  tx(components);
}

/** All components in the index, name-ordered (PRD §4.1). */
export function getAllComponents(db: DB): Component[] {
  const rows = db.prepare("SELECT * FROM components ORDER BY name").all() as ComponentRow[];
  return rows.map(rowToComponent);
}

/**
 * Components tagged with a given category key (PRD §3 taxonomy). Filtered in JS
 * because category_tags is a json array; the index is small (personal scale).
 */
export function getComponentsByCategory(db: DB, key: string): Component[] {
  return getAllComponents(db).filter((c) => c.categoryTags.includes(key));
}

/** Search options (PRD §4.1). `category` narrows results to a taxonomy key. */
export interface SearchOptions {
  category?: string;
  limit?: number;
}

/**
 * Substring search over name/description (PRD §4.1). Deliberately simple — a
 * case-insensitive LIKE is enough at personal catalog scale; FTS is a later
 * concern. Returns name-ordered matches.
 */
export function searchComponents(db: DB, query: string, opts: SearchOptions = {}): Component[] {
  const like = `%${query.toLowerCase()}%`;
  const rows = db
    .prepare(
      "SELECT * FROM components WHERE lower(name) LIKE ? OR lower(coalesce(description, '')) LIKE ? ORDER BY name",
    )
    .all(like, like) as ComponentRow[];
  let results = rows.map(rowToComponent);
  if (opts.category) {
    results = results.filter((c) => c.categoryTags.includes(opts.category as string));
  }
  if (opts.limit != null) results = results.slice(0, opts.limit);
  return results;
}

/** Raw inventory row shape (PRD §7 `inventory`). */
interface InventoryRow {
  component_ref: string;
  scope: string;
  project_path: string | null;
  enabled: number;
  source_file: string;
  scanned_at: string;
}

/**
 * Replace the persisted inventory snapshot (PRD §4.2, §7 `inventory`). The
 * snapshot is a point-in-time reflection of the scan, so the table is cleared
 * and rewritten wholesale inside one transaction — a stale row never survives a
 * fresh scan. `resolved` is an index-join annotation and is NOT persisted here;
 * it is recomputed on read by callers that reconcile against the live index.
 */
export function replaceInventory(db: DB, items: InventoryItem[]): void {
  const insert = db.prepare(/* sql */ `
    INSERT INTO inventory (component_ref, scope, project_path, enabled, source_file, scanned_at)
    VALUES (@component_ref, @scope, @project_path, @enabled, @source_file, @scanned_at)
    ON CONFLICT(component_ref, scope, project_path) DO UPDATE SET
      enabled = excluded.enabled,
      source_file = excluded.source_file,
      scanned_at = excluded.scanned_at
  `);
  const tx = db.transaction((rows: InventoryItem[]) => {
    db.prepare("DELETE FROM inventory").run();
    for (const item of rows) {
      insert.run({
        component_ref: item.componentRef,
        scope: item.scope,
        project_path: item.projectPath ?? null,
        enabled: item.enabled ? 1 : 0,
        source_file: item.sourceFile,
        scanned_at: item.scannedAt,
      });
    }
  });
  tx(items);
}

/** Look up a single component by id (PRD §4.1). Undefined when absent. */
export function getComponent(db: DB, id: string): Component | undefined {
  const row = db.prepare("SELECT * FROM components WHERE id = ?").get(id) as
    | ComponentRow
    | undefined;
  return row ? rowToComponent(row) : undefined;
}

/**
 * Read the persisted inventory snapshot (PRD §4.2). Empty is fine — before the
 * first scan there are simply no rows. Resolution against the index is left to
 * the caller (the recommender reconciles separately).
 */
export function getInventory(db: DB): InventoryItem[] {
  const rows = db.prepare("SELECT * FROM inventory ORDER BY component_ref").all() as InventoryRow[];
  return rows.map((row) => {
    const item: InventoryItem = {
      componentRef: row.component_ref,
      scope: row.scope as Scope,
      enabled: row.enabled !== 0,
      sourceFile: row.source_file,
      scannedAt: row.scanned_at,
    };
    if (row.project_path != null) item.projectPath = row.project_path;
    return item;
  });
}
