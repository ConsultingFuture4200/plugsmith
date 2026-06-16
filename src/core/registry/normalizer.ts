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
}): Component {
  const categoryTags = tagsToCategories(args.tags);
  let contextCostFlag = deriveContextCost(args.bundles);
  // Refine with allowed-tools breadth where declared (PRD §4.1): a component
  // granted a large tool surface is treated as context-costly even without an
  // MCP server or always-on hook.
  if (args.allowedTools && args.allowedTools.length >= 8) contextCostFlag = true;

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

/** Resolve `--category` as either a numeric id or a taxonomy key (PRD §4.1). */
export function resolveCategoryKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return categoryById(Number(trimmed))?.key;
  }
  return categoryByKey(trimmed)?.key;
}
