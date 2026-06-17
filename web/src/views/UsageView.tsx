import {
  type AuditComponentUsageDto,
  type AuditReportDto,
  type SuggestionDto,
  type UsageDto,
  type UsageStatDto,
  fetchUsage,
} from "@/api";
import { type Comparators, SortableHead, useSort } from "@/components/sortable";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { formatTokens } from "@/lib/display";
import {
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  CircleSlash,
  Lightbulb,
  Play,
  Scissors,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

/**
 * Usage view (README Roadmap: usage/audit surface). The visual form of
 * `plugsmith usage` — it scans the operator's real session transcripts
 * (read-only) and renders the AuditReport the SERVER produced via the SAME
 * `scanUsage` + `buildAudit` the CLI uses. The UI computes nothing the CLI
 * cannot: it only reshapes the returned report for display.
 *
 * The scan is heavier than the other reads (it streams ~1k transcripts), so this
 * view does NOT auto-load — the operator runs the audit on demand via the
 * "Run audit" button, optionally bounded to a 7/30-day window.
 */

/** The `?since` windows offered (value "all" = no bound, all history). */
const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "all", label: "All history" },
] as const;

type WindowValue = (typeof WINDOWS)[number]["value"];

const usageChartConfig: ChartConfig = {
  calls: { label: "Calls", color: "hsl(var(--chart-1))" },
};

/** Top-N chart datum: the normalized name and its call count. */
function toChartData(stats: UsageStatDto[]): Array<{ name: string; calls: number }> {
  return stats.map((s) => ({ name: s.name, calls: s.calls }));
}

/** Column comparators for the cost × usage table (sortable headers). */
const USAGE_SORT: Comparators<AuditComponentUsageDto> = {
  component: (a, b) => a.componentRef.localeCompare(b.componentRef),
  calls: (a, b) => a.calls - b.calls,
  sessions: (a, b) => a.sessions - b.sessions,
  lastUsed: (a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? ""),
  tokens: (a, b) => (a.contextTokens ?? 0) - (b.contextTokens ?? 0),
  costPerUse: (a, b) => (a.costPerUse ?? 0) - (b.costPerUse ?? 0),
};

export function UsageView(): React.JSX.Element {
  const [windowValue, setWindowValue] = React.useState<WindowValue>("30");
  const [data, setData] = React.useState<UsageDto | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const runAudit = React.useCallback(() => {
    setLoading(true);
    setError(null);
    const sinceDays = windowValue === "all" ? undefined : Number.parseInt(windowValue, 10);
    fetchUsage(sinceDays)
      .then((res) => setData(res))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [windowValue]);

  // Sort hook runs every render (before any early return) per the rules of hooks.
  const {
    sorted,
    state: sortState,
    toggle: onSort,
  } = useSort(data?.audit.installed ?? [], USAGE_SORT);

  return (
    <section className="space-y-6" aria-label="Usage audit">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Usage audit</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Reads your real Claude Code session transcripts under{" "}
          <span className="font-mono">~/.claude/projects</span> and joins them against your
          installed inventory. Strictly read-only — this mirrors{" "}
          <span className="font-mono">plugsmith usage</span> and renders the exact report the CLI
          produces.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select value={windowValue} onValueChange={(v) => setWindowValue(v as WindowValue)}>
          <SelectTrigger aria-label="Audit window" className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => (
              <SelectItem key={w.value} value={w.value}>
                {w.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={runAudit} disabled={loading}>
          <Play className="h-4 w-4" aria-hidden />
          {loading ? "Scanning transcripts…" : "Run audit"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Failed to run audit</AlertTitle>
          <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {loading && <UsageSkeleton />}

      {!loading && !error && data == null && (
        <Alert variant="info">
          <BarChart3 aria-hidden />
          <AlertTitle>No audit yet</AlertTitle>
          <AlertDescription>
            Pick a window and run the audit to scan your session transcripts.
          </AlertDescription>
        </Alert>
      )}

      {!loading && data != null && (
        <UsageReport
          report={data.audit}
          filesScanned={data.filesScanned}
          totalCalls={data.totalCalls}
          installed={sorted}
          sortState={sortState}
          onSort={onSort}
        />
      )}
    </section>
  );
}

function UsageReport({
  report,
  filesScanned,
  totalCalls,
  installed,
  sortState,
  onSort,
}: {
  report: AuditReportDto;
  filesScanned: number;
  totalCalls: number;
  installed: AuditComponentUsageDto[];
  sortState: ReturnType<typeof useSort<AuditComponentUsageDto>>["state"];
  onSort: (key: string) => void;
}): React.JSX.Element {
  const window = report.windowDays != null ? `last ${report.windowDays} day(s)` : "all history";
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        {filesScanned.toLocaleString()} transcript(s) · {totalCalls.toLocaleString()} tool call(s)
        scanned · window: {window}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <TopChart title="Top plugins" stats={report.topPlugins} />
        <TopChart title="Top skills" stats={report.topSkills} />
      </div>

      <CostUsageTable installed={installed} sortState={sortState} onSort={onSort} />

      <Suggestions suggestions={report.suggestions} />
    </div>
  );
}

function TopChart({ title, stats }: { title: string; stats: UsageStatDto[] }): React.JSX.Element {
  const chartData = toChartData(stats);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No usage in this window.
          </p>
        ) : (
          <ChartContainer config={usageChartConfig} className="aspect-auto h-[240px] w-full">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={140} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Bar
                dataKey="calls"
                fill="hsl(var(--chart-1))"
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

/** YYYY-MM-DD slice of an ISO timestamp, for compact "last used" display. */
function lastUsedDate(iso: string | undefined): string {
  if (iso == null) return "—";
  return iso.slice(0, 10);
}

function CostUsageTable({
  installed,
  sortState,
  onSort,
}: {
  installed: AuditComponentUsageDto[];
  sortState: ReturnType<typeof useSort<AuditComponentUsageDto>>["state"];
  onSort: (key: string) => void;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Cost × usage · {installed.length.toLocaleString()} installed component(s)
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {installed.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">
            No installed components.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead
                  label="Component"
                  sortKey="component"
                  state={sortState}
                  onSort={onSort}
                />
                <SortableHead
                  label="Calls"
                  sortKey="calls"
                  state={sortState}
                  onSort={onSort}
                  align="right"
                  className="w-px text-right"
                />
                <SortableHead
                  label="Sessions"
                  sortKey="sessions"
                  state={sortState}
                  onSort={onSort}
                  align="right"
                  className="hidden w-px text-right sm:table-cell"
                />
                <SortableHead
                  label="Last used"
                  sortKey="lastUsed"
                  state={sortState}
                  onSort={onSort}
                  align="right"
                  className="hidden w-px text-right md:table-cell"
                />
                <SortableHead
                  label="~Tokens"
                  sortKey="tokens"
                  state={sortState}
                  onSort={onSort}
                  align="right"
                  className="hidden w-px text-right lg:table-cell"
                />
                <SortableHead
                  label="Cost/use"
                  sortKey="costPerUse"
                  state={sortState}
                  onSort={onSort}
                  align="right"
                  className="w-px text-right"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {installed.map((row) => (
                <CostUsageRow key={row.componentRef} row={row} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CostUsageRow({ row }: { row: AuditComponentUsageDto }): React.JSX.Element {
  const neverUsed = row.calls === 0;
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{row.componentRef}</span>
          <Badge variant={row.kind === "skill" ? "info" : "secondary"} className="font-normal">
            {row.kind}
          </Badge>
        </span>
      </TableCell>
      <TableCell className="text-right align-top font-mono text-sm tabular-nums">
        {row.calls.toLocaleString()}
      </TableCell>
      <TableCell className="hidden text-right align-top font-mono text-sm tabular-nums sm:table-cell">
        {row.sessions.toLocaleString()}
      </TableCell>
      <TableCell className="hidden text-right align-top font-mono text-xs text-muted-foreground md:table-cell">
        {lastUsedDate(row.lastUsed)}
      </TableCell>
      <TableCell className="hidden text-right align-top lg:table-cell">
        {row.contextTokens != null ? (
          <span className="font-mono text-xs text-muted-foreground">
            {formatTokens(row.contextTokens)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right align-top">
        {neverUsed ? (
          <Badge variant="warn" className="font-normal">
            <CircleSlash className="h-3 w-3" aria-hidden />
            never used
          </Badge>
        ) : row.costPerUse != null ? (
          <span className="font-mono text-xs text-muted-foreground" title="context tokens per call">
            ~{Math.round(row.costPerUse)}/use
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Visual treatment for each suggestion kind (README Roadmap palette). */
const SUGGESTION_STYLE: Record<
  SuggestionDto["kind"],
  { label: string; icon: LucideIcon; badge: "warn" | "official" | "info" | "secondary" }
> = {
  trim: { label: "Trim", icon: Scissors, badge: "warn" },
  keep: { label: "Keep", icon: ShieldCheck, badge: "official" },
  add: { label: "Add", icon: ArrowUpRight, badge: "info" },
  "better-use": { label: "Better use", icon: Lightbulb, badge: "secondary" },
};

/** Stable display order of suggestion groups (trim → keep → add → better-use). */
const SUGGESTION_ORDER: SuggestionDto["kind"][] = ["trim", "keep", "add", "better-use"];

function Suggestions({ suggestions }: { suggestions: SuggestionDto[] }): React.JSX.Element {
  const byKind = React.useMemo(() => {
    const map = new Map<SuggestionDto["kind"], SuggestionDto[]>();
    for (const s of suggestions) {
      const list = map.get(s.kind) ?? [];
      list.push(s);
      map.set(s.kind, list);
    }
    return map;
  }, [suggestions]);

  if (suggestions.length === 0) {
    return (
      <Alert variant="info">
        <Lightbulb aria-hidden />
        <AlertTitle>No suggestions</AlertTitle>
        <AlertDescription>
          Nothing to trim, keep, add, or better-use in this window.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4" aria-label="Suggestions">
      <h3 className="text-sm font-semibold tracking-tight">Suggestions</h3>
      {SUGGESTION_ORDER.map((kind) => {
        const items = byKind.get(kind);
        if (items == null || items.length === 0) return null;
        const style = SUGGESTION_STYLE[kind];
        return (
          <div key={kind} className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <style.icon className="h-3.5 w-3.5" aria-hidden />
              {style.label}
              <span className="font-mono normal-case">({items.length})</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((s) => (
                <SuggestionCard key={`${s.kind}:${s.title}`} suggestion={s} badge={style.badge} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  badge,
}: {
  suggestion: SuggestionDto;
  badge: "warn" | "official" | "info" | "secondary";
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium leading-snug">{suggestion.title}</CardTitle>
        <Badge variant={badge} className="shrink-0 font-normal capitalize">
          {suggestion.kind}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">{suggestion.detail}</p>
        {suggestion.refs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {suggestion.refs.map((ref) => (
              <Badge key={ref} variant="outline" className="font-mono text-[10px] font-normal">
                {ref}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-72" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
