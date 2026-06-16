/**
 * `@ccharness/core` public surface (PRD §6).
 *
 * Pure functions over a local store where possible. No UI assumptions. The CLI
 * and the read-only dashboard both consume ONLY what is exported here — the UI
 * computes nothing the CLI cannot (PRD §4.6 architectural rule).
 */
export * from "./types.js";
export { TAXONOMY, categoryById, categoryByKey, singletonKeys } from "./taxonomy.js";
export {
  type CcharnessConfig,
  type ProviderName,
  DEFAULT_CONFIG,
  loadConfig,
  configDir,
} from "./config.js";
export { openStore, defaultDbPath, indexVersion, getMeta, setMeta, type DB } from "./db/store.js";
export {
  upsertComponents,
  getAllComponents,
  getComponentsByCategory,
  searchComponents,
  getInventory,
  type SearchOptions,
} from "./db/components.js";

// Registry (Milestone A)
export {
  sync,
  search,
  type SyncReport,
  type SyncSourceReport,
  type SearchQueryOptions,
} from "./registry/sync.js";
export {
  deriveContextCost,
  normalizeCanonical,
  normalizeOfficial,
  resolveCategoryKey,
  NormalizeError,
} from "./registry/normalizer.js";

// Inventory (Milestone B)
export { scanInventory, reconcile, type ScanReport } from "./inventory/scanner.js";

// Recommender (Milestone C) — the product
export {
  recommend,
  annotateStack,
  prefilter,
  validateProposal,
  CostAbortedError,
  type RecommendOptions,
} from "./recommender/index.js";
export {
  type ModelProvider,
  type ProposalInput,
  ProviderError,
  PROPOSAL_SCHEMA,
} from "./recommender/provider.js";
export { FakeProvider, type FakeProviderOptions } from "./recommender/providers/fake.js";

// CLAUDE.md managed block (Milestone D)
export { renderBlock, upsertBlock, writeBlockToFile, startDelimiter } from "./claudemd/block.js";
