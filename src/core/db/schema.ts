/**
 * SQLite schema (PRD §7). Four tables, minimal, no telemetry.
 *
 * The schema is applied idempotently on store open. `rec_cache` is
 * derived/disposable — it exists only to keep LLM cost near zero (PRD §4.8)
 * and may be cleared at any time.
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS marketplaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  git_url       TEXT NOT NULL,
  trust_default TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'custom',
  last_synced   TEXT
);

CREATE TABLE IF NOT EXISTS components (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  marketplace_id      TEXT NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
  trust_tier          TEXT NOT NULL,
  description         TEXT,
  category_tags       TEXT NOT NULL DEFAULT '[]', -- json array of category keys
  bundles             TEXT NOT NULL DEFAULT '{}', -- json: skills/commands/hooks/mcpServers
  context_cost_flag   INTEGER NOT NULL DEFAULT 0,
  context_tokens      INTEGER,                     -- always-on token cost (ref model), nullable
  singleton_categories TEXT NOT NULL DEFAULT '[]', -- json array
  compatibility       TEXT NOT NULL DEFAULT '[]', -- json array; stored, not acted on in v1
  allowed_tools       TEXT,                        -- json array, nullable
  version             TEXT,
  author              TEXT,
  license             TEXT,
  last_synced         TEXT
);

CREATE INDEX IF NOT EXISTS idx_components_marketplace ON components(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);

CREATE TABLE IF NOT EXISTS inventory (
  component_ref TEXT NOT NULL,
  scope         TEXT NOT NULL,          -- system | project
  project_path  TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  source_file   TEXT NOT NULL,
  scanned_at    TEXT NOT NULL,
  PRIMARY KEY (component_ref, scope, project_path)
);

CREATE TABLE IF NOT EXISTS rec_cache (
  task_signature TEXT NOT NULL,
  index_version  TEXT NOT NULL,
  scope          TEXT NOT NULL,
  proposal       TEXT NOT NULL,         -- json Recommendation
  provider       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (task_signature, index_version, scope)
);

-- Single-row metadata (index_version etc.) so cache invalidation is cheap.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
