import { AlertCircle, Search, Zap } from "lucide-react";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ComponentDto, fetchIndex } from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Comparators, SortableHead, useSort } from "@/components/sortable";
import { categoriesOf } from "@/lib/display";

/**
 * Index view (PRD §4.6): browse/filter/search the synced component index by
 * category and trust tier, with context-cost flags. The category-distribution
 * chart is the required recharts summary — it renders ONLY counts the API
 * already returned; the UI computes nothing the CLI cannot.
 */
const TRUST_TIERS = ["", "official", "partner", "community"] as const;

const chartConfig: ChartConfig = {
  count: { label: "Components", color: "hsl(var(--chart-1))" },
};

const TRUST_RANK: Record<string, number> = { official: 0, partner: 1, community: 2 };

/** Column comparators for the index table (sortable headers). */
const INDEX_SORT: Comparators<ComponentDto> = {
  component: (a, b) => a.name.localeCompare(b.name),
  categories: (a, b) =>
    (categoriesOf(a.categoryTags)[0] ?? "").localeCompare(categoriesOf(b.categoryTags)[0] ?? ""),
  trust: (a, b) => (TRUST_RANK[a.trustTier] ?? 9) - (TRUST_RANK[b.trustTier] ?? 9),
  signals: (a, b) => Number(b.contextCostFlag) - Number(a.contextCostFlag),
};

export function IndexView(): React.JSX.Element {
  const [q, setQ] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [trust, setTrust] = React.useState<string>("");
  const [components, setComponents] = React.useState<ComponentDto[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchIndex(q, category)
      .then((res) => {
        if (!cancelled) setComponents(res.components);
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
  }, [q, category]);

  // Trust-tier filter is applied client-side over API output (no new logic —
  // just hiding rows the API already returned).
  const visible = React.useMemo(
    () => (trust ? components.filter((c) => c.trustTier === trust) : components),
    [components, trust],
  );

  const categoryDistribution = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of visible) {
      for (const cat of categoriesOf(c.categoryTags)) {
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 14);
  }, [visible]);

  const { sorted, state: sortState, toggle: onSort } = useSort(visible, INDEX_SORT);

  return (
    <section className="space-y-6" aria-label="Component index">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Component index</h2>
        <p className="text-sm text-muted-foreground">
          Browse and filter the synced marketplace index. Trust tier, category, and
          context-cost are rendered exactly as the index resolves them.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or description…"
            aria-label="Search components by name or description"
            className="pl-9"
          />
        </div>
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category id or key"
          aria-label="Filter by category"
          className="sm:w-56"
        />
        <Select value={trust || "all"} onValueChange={(v) => setTrust(v === "all" ? "" : v)}>
          <SelectTrigger aria-label="Filter by trust tier" className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRUST_TIERS.map((t) => (
              <SelectItem key={t || "all"} value={t || "all"}>
                {t === "" ? "All tiers" : t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Failed to load index</AlertTitle>
          <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {!error && (loading || categoryDistribution.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Category distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : (
              <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
                <BarChart data={categoryDistribution} margin={{ left: 0, right: 8, top: 8, bottom: 8 }}>
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
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {loading ? "Loading…" : `${visible.length.toLocaleString()} component(s)`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <IndexSkeleton />
          ) : visible.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              No components match the current filters.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Component" sortKey="component" state={sortState} onSort={onSort} />
                  <SortableHead
                    label="Categories"
                    sortKey="categories"
                    state={sortState}
                    onSort={onSort}
                    className="hidden md:table-cell"
                  />
                  <SortableHead
                    label="Trust"
                    sortKey="trust"
                    state={sortState}
                    onSort={onSort}
                    align="right"
                    className="w-px text-right"
                  />
                  <SortableHead
                    label="Signals"
                    sortKey="signals"
                    state={sortState}
                    onSort={onSort}
                    align="right"
                    className="w-px text-right"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((c) => (
                  <ComponentRow key={c.id} component={c} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ComponentRow({ component: c }: { component: ComponentDto }): React.JSX.Element {
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{c.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
          {c.description && (
            <span className="mt-1 line-clamp-2 max-w-prose text-xs text-muted-foreground">
              {c.description}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden align-top md:table-cell">
        <div className="flex flex-wrap gap-1">
          {categoriesOf(c.categoryTags).map((cat) => (
            <Badge key={cat} variant="info" className="font-normal">
              {cat}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-right align-top">
        <Badge variant={c.trustTier}>{c.trustTier}</Badge>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-center justify-end gap-1.5">
          {c.contextCostFlag && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Badge variant="warn">
                    <Zap className="h-3 w-3" aria-hidden />
                    cost
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent>Flagged context-costly</TooltipContent>
            </Tooltip>
          )}
          {c.mcpServers > 0 && (
            <Badge variant="outline" className="font-mono text-[10px]">
              mcp:{c.mcpServers}
            </Badge>
          )}
          {c.hooks > 0 && (
            <Badge variant="outline" className="font-mono text-[10px]">
              hooks:{c.hooks}
            </Badge>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function IndexSkeleton(): React.JSX.Element {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 8 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <div key={i} className="flex items-center justify-between gap-4 px-6 py-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
      ))}
    </div>
  );
}
