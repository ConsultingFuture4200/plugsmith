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
  kind: "canonical" | "official" | "custom";
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
  local: { baseUrl: "http://localhost:8000/v1", model: "local" },
  marketplaces: [
    {
      name: "canonical-catalog",
      gitUrl: "https://github.com/(tbd)/marketplace.extended.json",
      kind: "canonical",
      trustDefault: "partner",
      enabled: true,
    },
    {
      name: "official-marketplace",
      gitUrl: "https://github.com/anthropics/claude-code",
      kind: "official",
      trustDefault: "official",
      enabled: true,
    },
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
