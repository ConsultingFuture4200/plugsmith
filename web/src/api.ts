/**
 * Typed client for the read-only plugsmith API (PRD §4.6).
 *
 * Mirrors the server DTOs in `src/server/api.ts`. The UI calls only these
 * read/recommend endpoints — there is no client method that mutates state,
 * because there is no server route that does (PRD §4.6 read-only boundary).
 */

export interface ComponentDto {
  id: string;
  name: string;
  trustTier: "official" | "partner" | "community";
  description: string;
  categoryTags: string[];
  contextCostFlag: boolean;
  mcpServers: number;
  hooks: number;
  singletonCategories: string[];
}

export interface InventoryItemDto {
  componentRef: string;
  scope: "system" | "project";
  projectPath?: string;
  enabled: boolean;
  sourceFile: string;
  scannedAt: string;
  resolved?: {
    categoryTags: string[];
    trustTier: "official" | "partner" | "community";
    contextCostFlag: boolean;
    description?: string;
    contextTokens?: number;
  } | null;
  /** Whether the ref is a skill or a plugin (PRD §4.2). */
  kind?: "skill" | "plugin";
  /**
   * Derived metadata for items not in the marketplace index, read from the
   * component's own definition (PRD §4.2). Present only when `resolved` is null.
   */
  derived?: {
    description?: string;
    categoryTags: string[];
    source: "skill-frontmatter" | "plugin-json";
  };
}

export interface StatusDto {
  items: InventoryItemDto[];
  unreadable: Array<{ file: string; reason: string }>;
}

export type RecAction = "enable" | "install" | "disable";

export interface RecLineDto {
  action: RecAction;
  componentRef: string;
  reason: string;
}

export interface AnnotationDto {
  severity: "info" | "warn" | "conflict";
  kind: "singleton" | "hook" | "command" | "context-cost";
  message: string;
  componentRefs: string[];
}

export interface RecommendationDto {
  task: string;
  lines: RecLineDto[];
  annotations: AnnotationDto[];
  contextCostSummary: { costlyCount: number; tightRequested: boolean; note?: string };
  provider: string;
  cached: boolean;
  indexVersion: string;
}

export interface RecommendRequest {
  task: string;
  scope?: "system" | "project";
  tight?: boolean;
  integrations?: string;
  provider?: "anthropic" | "local";
}

/** A usage kind on the wire (mirrors `UsageKind` in core). */
export type UsageKindDto = "plugin" | "skill" | "builtin";

/** One aggregated usage statistic (mirrors `UsageStat`, README Roadmap). */
export interface UsageStatDto {
  kind: UsageKindDto;
  name: string;
  calls: number;
  sessions: number;
  lastUsed?: string;
}

/** One actionable trim/keep/add/better-use suggestion (mirrors `Suggestion`). */
export interface SuggestionDto {
  kind: "trim" | "keep" | "add" | "better-use";
  title: string;
  detail: string;
  refs: string[];
}

/** Per-installed-component usage row (mirrors `AuditComponentUsage`). */
export interface AuditComponentUsageDto {
  componentRef: string;
  kind: "skill" | "plugin";
  categoryTags: string[];
  calls: number;
  sessions: number;
  lastUsed?: string;
  contextTokens?: number;
  costPerUse?: number;
}

/** The full usage/audit report (mirrors `AuditReport`, README Roadmap). */
export interface AuditReportDto {
  windowDays?: number;
  topPlugins: UsageStatDto[];
  topSkills: UsageStatDto[];
  topBuiltins: UsageStatDto[];
  installed: AuditComponentUsageDto[];
  unused: AuditComponentUsageDto[];
  activeCategories: string[];
  suggestions: SuggestionDto[];
}

/** GET /api/usage envelope: the audit plus scan provenance counters. */
export interface UsageDto {
  audit: AuditReportDto;
  filesScanned: number;
  totalCalls: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function fetchIndex(
  q: string,
  category: string,
): Promise<{ components: ComponentDto[] }> {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (category) params.set("category", category);
  const qs = params.toString();
  return getJson(`/api/index${qs ? `?${qs}` : ""}`);
}

export async function fetchStatus(): Promise<StatusDto> {
  return getJson("/api/status");
}

/**
 * GET /api/usage — the usage/audit report (README Roadmap). Heavier than the
 * other reads (it scans the operator's session transcripts), so the Usage view
 * fetches it on demand rather than on mount. `sinceDays` bounds the window
 * (omit/undefined = all history).
 */
export async function fetchUsage(sinceDays?: number): Promise<UsageDto> {
  const qs = sinceDays != null ? `?since=${sinceDays}` : "";
  return getJson(`/api/usage${qs}`);
}

export async function fetchRecommendation(
  req: RecommendRequest,
): Promise<{ recommendation: RecommendationDto }> {
  const res = await fetch("/api/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status}: request failed`);
  }
  return (await res.json()) as { recommendation: RecommendationDto };
}
