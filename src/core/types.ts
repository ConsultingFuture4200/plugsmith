/**
 * Core domain types for ccharness.
 *
 * These mirror the index/data model in PRD §3 (taxonomy), §4.1 (index model),
 * and §7 (SQLite schema). Keep this file dependency-free: it is the shared
 * vocabulary every other module speaks.
 */

/** Trust tier of a marketplace / component (PRD §4.1). */
export type TrustTier = "official" | "partner" | "community";

/**
 * Component category taxonomy (PRD §3). The index of categories is stable and
 * load-bearing: the recommender maps task signals → categories → components,
 * and the conflict checker keys singleton collisions off `singleton`.
 */
export interface Category {
  /** 1-based id matching PRD §3 ordering. */
  id: number;
  key: string;
  label: string;
  /** Having two enabled in a singleton category is a conflict, not a choice (PRD §3, §4.4). */
  singleton: boolean;
  /** Categories whose members are inherently context-costly (e.g. MCP connectors). */
  contextCostly?: boolean;
}

/** The bundled components a plugin/skill ships (PRD §4.1, §7 `components.bundles`). */
export interface ComponentBundles {
  skills: string[];
  commands: string[];
  /** Hook registrations: event + matcher, used by the hook-collision check (PRD §4.4). */
  hooks: Array<{ event: string; matcher?: string }>;
  /** MCP servers contributed — a primary context-cost signal (PRD §4.1). */
  mcpServers: string[];
}

/**
 * One normalized index entry (PRD §4.1, §7 `components`). Every marketplace
 * source is normalized into this single shape.
 */
export interface Component {
  id: string;
  name: string;
  marketplaceId: string;
  trustTier: TrustTier;
  description?: string;
  /** Category keys from the taxonomy (PRD §3). */
  categoryTags: string[];
  bundles: ComponentBundles;
  /**
   * Derived flag: true when the component adds an MCP server or an always-on
   * hook (SessionStart / broad PreToolUse). Refined by allowed-tools/schema
   * size where declared (PRD §4.1).
   */
  contextCostFlag: boolean;
  /**
   * Persistent (always-on) context cost in tokens for a reference model, taken
   * from the local cache's declared schema size. Used to refine the estimate
   * beyond the boolean flag (PRD §4.1 "use declared schema size to refine the
   * estimate"). Undefined when the source declares no per-model token cost.
   */
  contextTokens?: number;
  /** Category keys for which this component is a singleton occupant (PRD §4.4). */
  singletonCategories: string[];
  /**
   * Which agents/harnesses the component targets. Carried now for future
   * cross-agent awareness; NOT acted on in v1 (PRD §4.1, §7).
   */
  compatibility: string[];
  /** Declared allowed-tools, used to refine context-cost where present. */
  allowedTools?: string[];
  version?: string;
  author?: string;
  license?: string;
  lastSynced?: string;
}

/** A configured marketplace source (PRD §4.1, §7 `marketplaces`). */
export interface Marketplace {
  id: string;
  name: string;
  gitUrl: string;
  trustDefault: TrustTier;
  /** Which normalizer adapter ingests this source. */
  kind: "canonical" | "official" | "custom";
  lastSynced?: string;
}

/** Scope an inventory item lives in (PRD §4.2, §7 `inventory`). */
export type Scope = "system" | "project";

/** One installed component discovered by the inventory scanner (PRD §4.2, §7). */
export interface InventoryItem {
  componentRef: string;
  scope: Scope;
  projectPath?: string;
  enabled: boolean;
  sourceFile: string;
  scannedAt: string;
  /** Annotation joined from the index; null when "installed, not in index". */
  resolved?: Pick<Component, "categoryTags" | "trustTier" | "contextCostFlag"> | null;
}

/** Recommender action verbs (PRD §4.3). */
export type RecAction = "enable" | "install" | "disable";

/** One line of the LLM proposal / final recommendation (PRD §4.3). */
export interface RecLine {
  action: RecAction;
  componentRef: string;
  /** Prose reason, anchored to a real catalog entry (PRD §4.3 explainability). */
  reason: string;
}

/** Conflict / context-cost annotation severity (PRD §4.4). */
export type AnnotationSeverity = "info" | "warn" | "conflict";

/** A conflict / context-cost finding (PRD §4.4). */
export interface Annotation {
  severity: AnnotationSeverity;
  kind: "singleton" | "hook" | "command" | "context-cost";
  message: string;
  /** Components involved in this finding. */
  componentRefs: string[];
}

/**
 * The validated, grounded recommendation returned by the recommender (PRD §4.3).
 * Every line resolves to a real catalog entry; annotations are facts the model
 * cannot override.
 */
export interface Recommendation {
  task: string;
  lines: RecLine[];
  annotations: Annotation[];
  contextCostSummary: {
    costlyCount: number;
    tightRequested: boolean;
    /** Summed always-on token cost across the costly components, where known (PRD §4.1). */
    tokenBudget?: number;
    note?: string;
  };
  provider: string;
  /** True when this came from rec_cache rather than a fresh model call (PRD §4.8). */
  cached: boolean;
  /** Index version the recommendation was grounded against. */
  indexVersion: string;
}

/** The strict-JSON contract the model provider must return (PRD §4.7). */
export interface ProviderProposal {
  lines: RecLine[];
}
