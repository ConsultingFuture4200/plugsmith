import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { TrustTier } from "./types.js";

/** Provider selection for the recommender model (PRD §4.7). */
export type ProviderName = "anthropic" | "local";

export interface MarketplaceConfig {
  name: string;
  gitUrl: string;
  kind: "canonical" | "official" | "custom" | "local-cache";
  trustDefault: TrustTier;
  enabled: boolean;
}

export interface CcharnessConfig {
  /** Default model provider (PRD §12 Q3 — leaning local-default). */
  defaultProvider: ProviderName;
  anthropic?: { model: string; apiKeyEnv: string };
  local?: { baseUrl: string; model: string };
  /** Trusted marketplace sources (PRD §4.1). Canonical catalog is default. */
  marketplaces: MarketplaceConfig[];
  /** Pre-filter breadth knob (PRD §12 Q2) — tunable in Milestone C. */
  prefilterBreadth: "narrow" | "balanced" | "generous";
}

/** Config dir / files (PRD §4.7: `~/.ccharness/config.yaml`). */
export function configDir(): string {
  return join(homedir(), ".ccharness");
}

export const DEFAULT_CONFIG: CcharnessConfig = {
  defaultProvider: "local",
  anthropic: { model: "claude-opus-4-8", apiKeyEnv: "ANTHROPIC_API_KEY" },
  // qwen2.5:3b chosen over qwen3:4b as the default: the Milestone-0 validation
  // run showed qwen3:4b is non-deterministic at strict JSON (intermittent hard
  // failures even after the repair retry, from leaked <think> traces), while
  // qwen2.5:3b never hard-failed (always recovered on the single repair). See
  // docs/milestone-0-findings.md. `<think>` stripping (providers/shared.ts) also
  // makes qwen3:4b viable if you prefer it.
  local: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:3b" },
  marketplaces: [
    // Local Claude Code catalog cache — the primary index source with REAL
    // per-model token costs over the operator's installed marketplaces (PRD §4.1).
    {
      name: "local-cli-cache",
      gitUrl: "~/.claude/plugins/plugin-catalog-cache.json",
      kind: "local-cache",
      trustDefault: "community",
      enabled: true,
    },
    // Remote sources are DISABLED by default (enabled:false) pending verification.
    // The Milestone-0 run found two things: (1) a `gitUrl` must be the RAW
    // marketplace.json, not a GitHub repo page (a repo page returns HTML and the
    // source skips-loud); the canonical raw path below is confirmed. (2) Each
    // marketplace's JSON shape needs its adapter verified before enabling — the
    // canonical file is a 448-entry ARRAY with rich `keywords` (better category
    // mapping than the local cache), so it needs an adapter pass. Until then the
    // local-cli-cache above is the working primary. See docs/milestone-0-findings.md.
    {
      name: "canonical-catalog",
      gitUrl:
        "https://raw.githubusercontent.com/jeremylongshore/claude-code-plugins-plus-skills/main/.claude-plugin/marketplace.extended.json",
      kind: "canonical",
      trustDefault: "partner",
      enabled: false,
    },
    // Operator's other trusted marketplaces (from ~/.claude known_marketplaces).
    // NONE are in the local cache, so their installed plugins won't resolve until
    // these are enabled with correct raw .claude-plugin/marketplace.json URLs.
    { name: "parslee-marketplace", gitUrl: "https://raw.githubusercontent.com/Parslee-ai/claude-code-plugins/main/.claude-plugin/marketplace.json", kind: "official", trustDefault: "community", enabled: false },
    { name: "context-mode", gitUrl: "https://raw.githubusercontent.com/mksglu/context-mode/main/.claude-plugin/marketplace.json", kind: "official", trustDefault: "community", enabled: false },
    { name: "understand-anything", gitUrl: "https://raw.githubusercontent.com/Lum1104/Understand-Anything/main/.claude-plugin/marketplace.json", kind: "official", trustDefault: "community", enabled: false },
    { name: "agentmemory", gitUrl: "https://raw.githubusercontent.com/rohitg00/agentmemory/main/.claude-plugin/marketplace.json", kind: "official", trustDefault: "community", enabled: false },
    { name: "staqs", gitUrl: "https://raw.githubusercontent.com/staqsIO/terminalhire/main/.claude-plugin/marketplace.json", kind: "official", trustDefault: "community", enabled: false },
  ],
  prefilterBreadth: "balanced",
};

/**
 * Load config from `~/.ccharness/config.yaml`, falling back to DEFAULT_CONFIG.
 * Merges top-level keys so a partial user config still works. A key written
 * but left blank in YAML (parsed as `null`) must NOT clobber the default — e.g.
 * `anthropic:` with no value should keep the default block, not null it out.
 */
export function loadConfig(path = join(configDir(), "config.yaml")): CcharnessConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = (parseYaml(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
  // Drop null/undefined values so a blank YAML key falls back to the default.
  const provided = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== null && v !== undefined),
  );
  return { ...DEFAULT_CONFIG, ...provided };
}
