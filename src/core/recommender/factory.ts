import type { PlugsmithConfig, ProviderName } from "../config.js";
import { type ModelProvider, ProviderError } from "./provider.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { localProvider } from "./providers/local.js";

/**
 * Provider selection (PRD §4.7, Milestone C step 2).
 *
 * Given config + an optional `--provider` flag, return the right adapter. The
 * flag wins; otherwise `config.defaultProvider` decides (PRD §12 Q3). Core never
 * depends on which provider answered — only on the contract — so this factory is
 * the single place that knows the concrete adapters exist.
 */
export function selectProvider(config: PlugsmithConfig, override?: ProviderName): ModelProvider {
  const name = override ?? config.defaultProvider;

  switch (name) {
    case "anthropic": {
      if (!config.anthropic) {
        throw new ProviderError(
          "selectProvider: provider 'anthropic' requested but config.anthropic is absent",
        );
      }
      return anthropicProvider({
        model: config.anthropic.model,
        apiKeyEnv: config.anthropic.apiKeyEnv,
      });
    }
    case "local": {
      if (!config.local) {
        throw new ProviderError(
          "selectProvider: provider 'local' requested but config.local is absent",
        );
      }
      return localProvider({
        baseUrl: config.local.baseUrl,
        model: config.local.model,
      });
    }
    default: {
      const exhaustive: never = name;
      throw new ProviderError(`selectProvider: unknown provider "${String(exhaustive)}"`);
    }
  }
}
