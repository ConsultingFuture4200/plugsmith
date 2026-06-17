import type { ComponentDto } from "@/api";

export type TrustTier = ComponentDto["trustTier"];

/** Map a trust tier to its Badge variant (official=emerald, partner=sky, community=muted). */
export function trustVariant(tier: TrustTier): "official" | "partner" | "community" {
  return tier;
}

/** Format a token count as a compact mono string, e.g. 12000 -> "~12k tok". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    const rounded = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
    return `~${rounded}k tok`;
  }
  return `~${tokens} tok`;
}

/** Category tags with an "uncategorized" fallback (mirrors CLI rendering). */
export function categoriesOf(tags: string[]): string[] {
  return tags.length > 0 ? tags : ["uncategorized"];
}
