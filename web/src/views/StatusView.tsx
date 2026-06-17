import {
  AlertCircle,
  AlertTriangle,
  CircleSlash,
  MonitorCog,
  Package,
  Power,
  PowerOff,
  Sparkles,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type InventoryItemDto, type StatusDto, fetchStatus } from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { type Comparators, SortableHead, useSort } from "@/components/sortable";
import { categoriesOf } from "@/lib/display";

/**
 * Status view (PRD §4.6): the visual form of `ccharness status`. Renders the
 * reconciled inventory snapshot as a category-distribution chart plus an
 * individual per-component table (mirroring the Index view), with enabled state
 * and the index annotation. Unreadable settings files surface, never silently
 * dropped (PRD §8). Read-only: no enable/disable control exists.
 */

/** A plugin ref is `name@marketplace`; a skill is a bare name. */
function isSkill(ref: string): boolean {
  return !ref.includes("@");
}

const chartConfig: ChartConfig = {
  count: { label: "Installed", color: "hsl(var(--chart-1))" },
};

const TRUST_RANK: Record<string, number> = { official: 0, partner: 1, community: 2 };

function indexRank(i: InventoryItemDto): number {
  return i.resolved == null ? 99 : (TRUST_RANK[i.resolved.trustTier] ?? 9);
}

/** Column comparators for the installed-components table (sortable headers). */
const STATUS_SORT: Comparators<InventoryItemDto> = {
  component: (a, b) => a.componentRef.localeCompare(b.componentRef),
  type: (a, b) => Number(isSkill(a.componentRef)) - Number(isSkill(b.componentRef)),
  scope: (a, b) => a.scope.localeCompare(b.scope),
  index: (a, b) => indexRank(a) - indexRank(b),
};

interface Stats {
  total: number;
  skills: number;
  enabled: number;
  notInIndex: number;
  contextCostly: number;
}

function computeStats(items: InventoryItemDto[]): Stats {
  let skills = 0;
  let enabled = 0;
  let notInIndex = 0;
  let contextCostly = 0;
  for (const i of items) {
    if (isSkill(i.componentRef)) skills += 1;
    if (i.enabled) enabled += 1;
    if (i.resolved == null) notInIndex += 1;
    else if (i.resolved.contextCostFlag) contextCostly += 1;
  }
  return { total: items.length, skills, enabled, notInIndex, contextCostly };
}

/**
 * Category distribution across installed components — the same summary as the
 * Index chart, over the operator's inventory. Unresolved items bucket into
 * "not in index" (the parallel of the Index chart's "uncategorized"). Renders
 * only counts the API already returned; the UI computes nothing the CLI cannot.
 */
function categoryDistribution(items: InventoryItemDto[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const i of items) {
    const cats = i.resolved == null ? ["not in index"] : categoriesOf(i.resolved.categoryTags);
    for (const cat of cats) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 14);
}

export function StatusView(): React.JSX.Element {
  const [data, setData] = React.useState<StatusDto | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    fetchStatus()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sort hook runs every render (before the early returns) to satisfy the rules
  // of hooks; it operates on the items once data has loaded.
  const { sorted, state: sortState, toggle: onSort } = useSort(data?.items ?? [], STATUS_SORT);

  if (loading) return <StatusSkeleton />;

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>Failed to load status</AlertTitle>
        <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
      </Alert>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  const stats = computeStats(data.items);
  const distribution = categoryDistribution(data.items);
  const plugins = stats.total - stats.skills;

  return (
    <section className="space-y-6" aria-label="Installed inventory status">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Installed inventory</h2>
        <p className="text-sm text-muted-foreground">
          Reconciled snapshot of what is installed across scopes. Read-only — this mirrors{" "}
          <span className="font-mono">ccharness status</span>.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Installed" value={stats.total} icon={MonitorCog} />
        <StatCard label="Skills" value={stats.skills} icon={Sparkles} accent="primary" />
        <StatCard label="Enabled" value={stats.enabled} icon={Power} accent="primary" />
        <StatCard label="Context-costly" value={stats.contextCostly} icon={Zap} accent="warn" />
        <StatCard label="Not in index" value={stats.notInIndex} icon={CircleSlash} accent="muted" />
      </div>

      {data.items.length === 0 && (
        <Alert variant="info">
          <CircleSlash aria-hidden />
          <AlertTitle>No installed components found</AlertTitle>
          <AlertDescription>Nothing is currently installed in any scope.</AlertDescription>
        </Alert>
      )}

      {distribution.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Installed by category</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
              <BarChart data={distribution} margin={{ left: 0, right: 8, top: 8, bottom: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  angle={-30}
                  textAnchor="end"
                  height={70}
                />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                <Bar
                  dataKey="count"
                  fill="hsl(var(--chart-1))"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      {data.items.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {stats.total.toLocaleString()} installed · {stats.skills} skill(s) · {plugins} plugin(s)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Component" sortKey="component" state={sortState} onSort={onSort} />
                  <SortableHead
                    label="Type"
                    sortKey="type"
                    state={sortState}
                    onSort={onSort}
                    className="hidden sm:table-cell"
                  />
                  <SortableHead
                    label="Scope"
                    sortKey="scope"
                    state={sortState}
                    onSort={onSort}
                    className="hidden md:table-cell"
                  />
                  <SortableHead
                    label="Index"
                    sortKey="index"
                    state={sortState}
                    onSort={onSort}
                    align="right"
                    className="w-px text-right"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((item) => (
                  <StatusRow key={`${item.scope}:${item.componentRef}`} item={item} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data.unreadable.length > 0 && (
        <Alert variant="warn">
          <AlertTriangle aria-hidden />
          <AlertTitle>Unreadable settings</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-1">
              {data.unreadable.map((u) => (
                <li key={u.file} className="text-xs">
                  <span className="font-mono">{u.file}</span> — {u.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function StatusRow({ item }: { item: InventoryItemDto }): React.JSX.Element {
  const skill = isSkill(item.componentRef);
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="flex min-w-0 items-center gap-2.5">
          {item.enabled ? (
            <Badge variant="official">
              <Power className="h-3 w-3" aria-hidden />
              on
            </Badge>
          ) : (
            <Badge variant="disabled">
              <PowerOff className="h-3 w-3" aria-hidden />
              off
            </Badge>
          )}
          <span className="truncate font-mono text-sm">{item.componentRef}</span>
        </span>
      </TableCell>
      <TableCell className="hidden align-top sm:table-cell">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {skill ? (
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Package className="h-3.5 w-3.5" aria-hidden />
          )}
          {skill ? "skill" : "plugin"}
        </span>
      </TableCell>
      <TableCell className="hidden align-top font-mono text-xs text-muted-foreground md:table-cell">
        {item.scope}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {item.resolved == null ? (
            <Badge variant="warn">
              <CircleSlash className="h-3 w-3" aria-hidden />
              not in index
            </Badge>
          ) : (
            <>
              {categoriesOf(item.resolved.categoryTags).map((cat) => (
                <Badge key={cat} variant="info" className="hidden font-normal lg:inline-flex">
                  {cat}
                </Badge>
              ))}
              <Badge variant={item.resolved.trustTier}>{item.resolved.trustTier}</Badge>
              {item.resolved.contextCostFlag && (
                <Badge variant="warn">
                  <Zap className="h-3 w-3" aria-hidden />
                  cost
                </Badge>
              )}
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

const ACCENTS = {
  default: "text-foreground",
  primary: "text-primary",
  warn: "text-warn-foreground",
  muted: "text-muted-foreground",
} as const;

function StatCard({
  label,
  value,
  icon: Icon,
  accent = "default",
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  accent?: keyof typeof ACCENTS;
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-2 p-4">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`font-mono text-2xl font-semibold tabular-nums ${ACCENTS[accent]}`}>
            {value}
          </p>
        </div>
        <Icon className={`h-5 w-5 ${ACCENTS[accent]}`} aria-hidden />
      </CardContent>
    </Card>
  );
}

function StatusSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-48" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <Skeleton key={i} className="h-[88px] w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[220px] w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
