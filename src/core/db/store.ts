import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

/** Default store path (PRD §6: `~/.plugsmith/plugsmith.db`). */
export function defaultDbPath(): string {
  return join(homedir(), ".plugsmith", "plugsmith.db");
}

export type DB = Database.Database;

/**
 * Open (and create-if-missing) the SQLite store, applying the schema
 * idempotently. Pass `:memory:` for tests.
 */
export function openStore(path: string = defaultDbPath()): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyAdditiveMigrations(db);
  return db;
}

/**
 * Additive, idempotent column migrations for stores created before a column was
 * added to the schema (PRD §7). `CREATE TABLE IF NOT EXISTS` does not retrofit
 * new columns onto an existing table, so a pre-existing `~/.plugsmith` DB would
 * otherwise lack `context_tokens` and fail every upsert. Each migration is a
 * guarded `ADD COLUMN` — safe to run on every open.
 */
function applyAdditiveMigrations(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(components)").all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  // contextTokens: always-on token cost from the local cache (PRD §4.1).
  if (!has("context_tokens")) {
    db.exec("ALTER TABLE components ADD COLUMN context_tokens INTEGER");
  }
}

/** Read a meta value (e.g. the current index version that backs cache keys). */
export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Upsert a meta value. */
export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Current index version; defaults to "0" before the first sync. */
export function indexVersion(db: DB): string {
  return getMeta(db, "index_version") ?? "0";
}
