import { categoryById, categoryByKey, singletonKeys } from "../taxonomy.js";
import type { Component, ComponentBundles, TrustTier } from "../types.js";

/**
 * Normalizer (PRD §4.1, Milestone A step 4).
 *
 * Maps a raw source entry into the single `Component` index model. The
 * canonical `marketplace.extended.json` is the primary, low-risk path (mostly
 * field mapping); a thinner adapter handles the official-marketplace shape.
 *
 * Contract: each adapter normalizes ONE entry. A malformed entry throws
 * `NormalizeError` so the caller (`sync`) can skip-loud and keep per-source
 * parsed/skipped counts (PRD §8).
 */
export class NormalizeError extends Error {}

/**
 * Catalog `tags` → taxonomy category key map (PRD §3, §4.1).
 *
 * The canonical catalog's free-text `tags` are not our 13-key taxonomy, so we
 * map known tags onto category keys here. The map is intentionally explicit and
 * conservative: an unrecognized tag is dropped rather than guessed, so a noisy
 * tag never invents a category. Values on the right MUST exist in `taxonomy.ts`.
 */
const TAG_TO_CATEGORY: Record<string, string> = {
  // 1 project-mgmt
  "project-management": "project-mgmt",
  "project-mgmt": "project-mgmt",
  planning: "project-mgmt",
  spec: "project-mgmt",
  "spec-driven": "project-mgmt",
  prd: "project-mgmt",
  workflow: "project-mgmt",
  // 2 context-mgmt
  context: "context-mgmt",
  "context-management": "context-mgmt",
  "context-mgmt": "context-mgmt",
  // 3 memory
  memory: "memory",
  persistence: "memory",
  knowledge: "memory",
  // 4 code-quality
  "code-quality": "code-quality",
  lint: "code-quality",
  linter: "code-quality",
  guardrails: "code-quality",
  refactor: "code-quality",
  // 5 security
  security: "security",
  "supply-chain": "security",
  audit: "security",
  secrets: "security",
  // 6 git
  git: "git",
  vcs: "git",
  github: "git",
  commit: "git",
  // 7 code-review
  "code-review": "code-review",
  review: "code-review",
  pr: "code-review",
  // 8 testing
  testing: "testing",
  test: "testing",
  tests: "testing",
  verification: "testing",
  ci: "testing",
  // 9 multi-agent
  "multi-agent": "multi-agent",
  agent: "multi-agent",
  agents: "multi-agent",
  orchestration: "multi-agent",
  // 10 observability
  observability: "observability",
  telemetry: "observability",
  logging: "observability",
  monitoring: "observability",
  // 11 integrations
  integration: "integrations",
  integrations: "integrations",
  mcp: "integrations",
  connector: "integrations",
  api: "integrations",
  // 12 domain
  domain: "domain",
  // 13 output-styling
  "output-styling": "output-styling",
  formatting: "output-styling",
  styling: "output-styling",
  output: "output-styling",
};

const SINGLETON_KEYS = new Set(singletonKeys());

const EMPTY_BUNDLES: ComponentBundles = {
  skills: [],
  commands: [],
  hooks: [],
  mcpServers: [],
};

/** Derive the context-cost flag (PRD §4.1). MCP server or always-on hook → costly. */
export function deriveContextCost(bundles: Component["bundles"]): boolean {
  if (bundles.mcpServers.length > 0) return true;
  const ALWAYS_ON = new Set(["SessionStart", "UserPromptSubmit"]);
  return bundles.hooks.some(
    (h) => ALWAYS_ON.has(h.event) || (h.event === "PreToolUse" && !h.matcher),
  );
}

/** Map catalog tags onto our taxonomy keys; unknown tags are dropped (PRD §3). */
function tagsToCategories(tags: string[]): string[] {
  const keys = new Set<string>();
  for (const tag of tags) {
    const key = TAG_TO_CATEGORY[tag.toLowerCase().trim()];
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Derive which singleton categories this component lands in (PRD §4.4). */
function singletonCategoriesFor(categoryTags: string[]): string[] {
  return categoryTags.filter((key) => SINGLETON_KEYS.has(key));
}

/** Coerce a value into a clean string array, dropping non-strings. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** A canonical-catalog entry as it appears in `marketplace.extended.json`. */
interface CanonicalEntry {
  name?: unknown;
  description?: unknown;
  "allowed-tools"?: unknown;
  allowedTools?: unknown;
  version?: unknown;
  author?: unknown;
  license?: unknown;
  compatibility?: unknown;
  tags?: unknown;
  bundles?: {
    skills?: unknown;
    commands?: unknown;
    hooks?: unknown;
    mcpServers?: unknown;
  };
}

/** Normalize the hooks array, keeping only well-formed {event, matcher?} entries. */
function normalizeHooks(value: unknown): ComponentBundles["hooks"] {
  if (!Array.isArray(value)) return [];
  const hooks: ComponentBundles["hooks"] = [];
  for (const h of value) {
    if (h && typeof h === "object" && typeof (h as { event?: unknown }).event === "string") {
      const event = (h as { event: string }).event;
      const matcher = (h as { matcher?: unknown }).matcher;
      hooks.push(typeof matcher === "string" ? { event, matcher } : { event });
    }
  }
  return hooks;
}

/**
 * Build a Component from already-validated common fields, deriving category
 * tags, singleton categories, and the context-cost flag. Shared by both
 * adapters so derivation rules stay identical across sources.
 */
function buildComponent(args: {
  id: string;
  name: string;
  marketplaceId: string;
  trustTier: TrustTier;
  description?: string | undefined;
  tags: string[];
  bundles: ComponentBundles;
  compatibility: string[];
  allowedTools?: string[] | undefined;
  version?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
  /** Always-on token cost (ref model) from the local cache, where declared (PRD §4.1). */
  contextTokens?: number | undefined;
  /** When set, OR'd into the derived context-cost flag (local cache: >=1500 tokens). */
  forceContextCostly?: boolean | undefined;
}): Component {
  const categoryTags = tagsToCategories(args.tags);
  let contextCostFlag = deriveContextCost(args.bundles);
  // Refine with allowed-tools breadth where declared (PRD §4.1): a component
  // granted a large tool surface is treated as context-costly even without an
  // MCP server or always-on hook.
  if (args.allowedTools && args.allowedTools.length >= 8) contextCostFlag = true;
  // Refine with the declared always-on schema size (PRD §4.1): a large token
  // footprint is context-costly even without an MCP server or always-on hook.
  if (args.forceContextCostly) contextCostFlag = true;

  const component: Component = {
    id: args.id,
    name: args.name,
    marketplaceId: args.marketplaceId,
    trustTier: args.trustTier,
    categoryTags,
    bundles: args.bundles,
    contextCostFlag,
    singletonCategories: singletonCategoriesFor(categoryTags),
    compatibility: args.compatibility,
  };
  if (args.description != null) component.description = args.description;
  if (args.contextTokens != null) component.contextTokens = args.contextTokens;
  if (args.allowedTools != null) component.allowedTools = args.allowedTools;
  if (args.version != null) component.version = args.version;
  if (args.author != null) component.author = args.author;
  if (args.license != null) component.license = args.license;
  return component;
}

/**
 * Canonical-catalog ingester (PRD §4.1, Milestone A step 2).
 *
 * Maps the enforced frontmatter
 * (name / description / allowed-tools / version / author / license /
 * compatibility / tags) straight into Component, mapping `tags` onto the 13-key
 * taxonomy and deriving singleton categories + context-cost. `name` is
 * required; a missing/blank name is malformed and throws so the caller can
 * skip-loud (PRD §8).
 *
 * NOTE: the catalog does not declare hooks at event+matcher granularity, so
 * `bundles.hooks` is left empty unless the source ships a structured `bundles`
 * block — see the returned notes for this known gap.
 */
export function normalizeCanonical(
  raw: unknown,
  marketplaceId: string,
  trust: TrustTier,
): Component {
  if (!raw || typeof raw !== "object") {
    throw new NormalizeError("canonical entry is not an object");
  }
  const entry = raw as CanonicalEntry;
  if (typeof entry.name !== "string" || entry.name.trim() === "") {
    throw new NormalizeError("canonical entry missing required 'name'");
  }
  const name = entry.name.trim();

  const allowedToolsRaw = entry["allowed-tools"] ?? entry.allowedTools;
  const allowedTools = allowedToolsRaw != null ? asStringArray(allowedToolsRaw) : undefined;

  const bundles: ComponentBundles = {
    ...EMPTY_BUNDLES,
    skills: asStringArray(entry.bundles?.skills),
    commands: asStringArray(entry.bundles?.commands),
    hooks: normalizeHooks(entry.bundles?.hooks),
    mcpServers: asStringArray(entry.bundles?.mcpServers),
  };

  return buildComponent({
    id: `${marketplaceId}:${name}`,
    name,
    marketplaceId,
    trustTier: trust,
    description: typeof entry.description === "string" ? entry.description : undefined,
    tags: asStringArray(entry.tags),
    bundles,
    compatibility: asStringArray(entry.compatibility),
    allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
    version: typeof entry.version === "string" ? entry.version : undefined,
    author: typeof entry.author === "string" ? entry.author : undefined,
    license: typeof entry.license === "string" ? entry.license : undefined,
  });
}

/** A plugin entry in the official `.claude-plugin/marketplace.json` shape. */
interface OfficialEntry {
  name?: unknown;
  description?: unknown;
  version?: unknown;
  author?: unknown;
  license?: unknown;
  category?: unknown;
  keywords?: unknown;
  tags?: unknown;
}

/**
 * Official-marketplace adapter (`.claude-plugin/marketplace.json` shape).
 *
 * Thinner than the canonical catalog: trust tier is fixed `official` and the
 * shape carries no structured bundles, so `bundles` is empty and context-cost
 * derives to false unless tags/keywords map to a costly category. Tags are read
 * from `category` / `keywords` / `tags`, whichever the entry provides.
 */
export function normalizeOfficial(raw: unknown, marketplaceId: string): Component {
  if (!raw || typeof raw !== "object") {
    throw new NormalizeError("official entry is not an object");
  }
  const entry = raw as OfficialEntry;
  if (typeof entry.name !== "string" || entry.name.trim() === "") {
    throw new NormalizeError("official entry missing required 'name'");
  }
  const name = entry.name.trim();

  const tags: string[] = [];
  if (typeof entry.category === "string") tags.push(entry.category);
  tags.push(...asStringArray(entry.keywords));
  tags.push(...asStringArray(entry.tags));

  return buildComponent({
    id: `${marketplaceId}:${name}`,
    name,
    marketplaceId,
    trustTier: "official",
    description: typeof entry.description === "string" ? entry.description : undefined,
    tags,
    bundles: { ...EMPTY_BUNDLES },
    compatibility: [],
    allowedTools: undefined,
    version: typeof entry.version === "string" ? entry.version : undefined,
    author: typeof entry.author === "string" ? entry.author : undefined,
    license: typeof entry.license === "string" ? entry.license : undefined,
  });
}

/**
 * One ENTRY in the local Claude Code catalog cache
 * (`~/.claude/plugins/plugin-catalog-cache.json` → `catalog.plugins[key]`).
 * Keyed by `<name>@<marketplace>`; values mirror the cache's confirmed shape.
 */
interface LocalCacheEntry {
  plugin?: unknown;
  tokens?: unknown; // { "<model>": { always_on, on_invoke } }
  components?: {
    commands?: unknown; // [{ name, chars }]
    agents?: unknown;
    skills?: unknown; // [{ name, chars: { always_on, on_invoke } }]
    hooks?: unknown; // bare event-name strings (observed) / objects / nested (defensive)
    mcpServers?: unknown; // string[]
    lspServers?: unknown; // ignored
  };
  marketplace_entry?: {
    name?: unknown;
    description?: unknown;
    category?: unknown;
    keywords?: unknown;
    tags?: unknown;
    version?: unknown;
    author?: unknown;
  };
  version?: unknown;
  source?: unknown;
}

/** Options for the local-cache adapter (PRD §4.1, Milestone A/B). */
export interface NormalizeLocalCacheOptions {
  /** The full `<name>@<marketplace>` cache key — becomes Component.id (Milestone B reconciliation). */
  key: string;
  /** Default trust tier for non-official marketplaces (from config). */
  trustDefault: TrustTier;
  /** Reference models from `catalog.models`; first present `always_on` is used. */
  refModels?: string[];
}

/** Pull `{name}`/`{chars}` component names out of a cache component array. */
function cacheComponentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const el of value) {
    if (typeof el === "string") names.push(el);
    else if (el && typeof el === "object" && typeof (el as { name?: unknown }).name === "string") {
      names.push((el as { name: string }).name);
    }
  }
  return names;
}

/**
 * Normalize the cache's `components.hooks` into {event, matcher?} entries
 * BEST-EFFORT (PRD §4.1 open spike). The shape is under-specified: observed
 * elements are bare event-name strings, but objects (`{event}`/`{matcher}`) and
 * nested `{hooks:[...]}` forms are handled defensively. An unrecognized element
 * keeps event best-effort with matcher undefined and NEVER throws on hook shape.
 */
function localCacheHooks(value: unknown): ComponentBundles["hooks"] {
  if (!Array.isArray(value)) return [];
  const hooks: ComponentBundles["hooks"] = [];
  for (const el of value) {
    if (typeof el === "string") {
      hooks.push({ event: el });
      continue;
    }
    if (el && typeof el === "object") {
      const obj = el as { event?: unknown; matcher?: unknown; hooks?: unknown };
      // Nested `{ hooks: [...] }` form: recurse, inheriting the outer event if any.
      if (Array.isArray(obj.hooks)) {
        const event = typeof obj.event === "string" ? obj.event : "unknown";
        const matcher = typeof obj.matcher === "string" ? obj.matcher : undefined;
        for (const inner of obj.hooks) {
          if (typeof inner === "string") {
            hooks.push(matcher != null ? { event, matcher: inner } : { event, matcher: undefined });
          } else {
            hooks.push(matcher != null ? { event, matcher } : { event });
          }
        }
        continue;
      }
      const event = typeof obj.event === "string" ? obj.event : "unknown";
      const matcher = typeof obj.matcher === "string" ? obj.matcher : undefined;
      hooks.push(matcher != null ? { event, matcher } : { event });
      continue;
    }
    // Unrecognized element shape: best-effort, never throw.
    hooks.push({ event: "unknown" });
  }
  return hooks;
}

/**
 * Pick the reference always-on token cost from the entry's per-model `tokens`
 * (PRD §4.1). Prefer the first ref model present; otherwise fall back to the
 * largest `always_on` declared. Returns undefined when no usable value exists.
 */
function refContextTokens(tokens: unknown, refModels: string[]): number | undefined {
  if (!tokens || typeof tokens !== "object") return undefined;
  const byModel = tokens as Record<string, unknown>;
  const alwaysOn = (model: unknown): number | undefined => {
    if (!model || typeof model !== "object") return undefined;
    const v = (model as { always_on?: unknown }).always_on;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  for (const ref of refModels) {
    const v = alwaysOn(byModel[ref]);
    if (v != null) return v;
  }
  let max: number | undefined;
  for (const model of Object.values(byModel)) {
    const v = alwaysOn(model);
    if (v != null && (max == null || v > max)) max = v;
  }
  return max;
}

/** Token threshold at/above which an always-on schema size is context-costly (PRD §4.1). */
const CONTEXT_TOKEN_COSTLY = 1500;

/**
 * Local-cache adapter (PRD §4.1, Milestone A/B). Maps one cache ENTRY into a
 * Component using REAL per-model token costs from the local Claude Code catalog.
 *
 * Critical: Component.id is set to the FULL `<name>@<marketplace>` cache KEY (not
 * the bare plugin name) — installed-plugin refs use exactly this form, so
 * Milestone B reconciliation resolves real installed plugins against the index.
 *
 * trustTier: `official` for the Anthropic-managed marketplace,
 * `partner` for the canonical source, else the configured community default.
 * `contextTokens` is the ref model's `always_on`; the context-cost flag is true
 * when that meets the token threshold, or an MCP server / hook is present.
 *
 * Throws `NormalizeError` on a malformed ENTRY (missing plugin name / bad key)
 * so `sync` can skip-loud (PRD §8). Hook-shape quirks never throw (see step 5).
 */
export function normalizeLocalCache(raw: unknown, opts: NormalizeLocalCacheOptions): Component {
  if (!raw || typeof raw !== "object") {
    throw new NormalizeError("local-cache entry is not an object");
  }
  const entry = raw as LocalCacheEntry;
  if (typeof entry.plugin !== "string" || entry.plugin.trim() === "") {
    throw new NormalizeError("local-cache entry missing required 'plugin'");
  }
  const name = entry.plugin.trim();

  const atIndex = opts.key.indexOf("@");
  if (atIndex <= 0 || atIndex === opts.key.length - 1) {
    throw new NormalizeError(`local-cache key not '<name>@<marketplace>': ${opts.key}`);
  }
  const marketplace = opts.key.slice(atIndex + 1);
  const trustTier: TrustTier =
    marketplace === "claude-plugins-official"
      ? "official"
      : marketplace === "canonical-catalog"
        ? "partner"
        : opts.trustDefault;

  const me = entry.marketplace_entry ?? {};
  const tags: string[] = [];
  if (typeof me.category === "string") tags.push(me.category);
  tags.push(...asStringArray(me.keywords));
  tags.push(...asStringArray(me.tags));

  const components = entry.components ?? {};
  const bundles: ComponentBundles = {
    skills: cacheComponentNames(components.skills),
    commands: cacheComponentNames(components.commands),
    hooks: localCacheHooks(components.hooks),
    mcpServers: asStringArray(components.mcpServers),
  };

  const contextTokens = refContextTokens(entry.tokens, opts.refModels ?? []);
  const forceContextCostly = contextTokens != null && contextTokens >= CONTEXT_TOKEN_COSTLY;

  const version =
    typeof entry.version === "string"
      ? entry.version
      : typeof me.version === "string"
        ? me.version
        : undefined;

  return buildComponent({
    id: opts.key,
    name,
    marketplaceId: marketplace,
    trustTier,
    description: typeof me.description === "string" ? me.description : undefined,
    tags,
    bundles,
    compatibility: [],
    allowedTools: undefined,
    version,
    author: typeof me.author === "string" ? me.author : undefined,
    license: undefined,
    contextTokens,
    forceContextCostly,
  });
}

/** Resolve `--category` as either a numeric id or a taxonomy key (PRD §4.1). */
export function resolveCategoryKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return categoryById(Number(trimmed))?.key;
  }
  return categoryByKey(trimmed)?.key;
}
