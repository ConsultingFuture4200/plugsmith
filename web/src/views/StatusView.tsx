import {
  AlertCircle,
  AlertTriangle,
  CircleSlash,
  FolderCog,
  type LucideIcon,
  MonitorCog,
  Power,
  PowerOff,
  Zap,
} from "lucide-react";
import * as React from "react";
import { type InventoryItemDto, type StatusDto, fetchStatus } from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { categoriesOf } from "@/lib/display";

/**
 * Status view (PRD §4.6): the visual form of `ccharness status`. Renders the
 * reconciled inventory snapshot grouped by scope, with enabled state and the
 * index annotation. Unreadable settings files surface, never silently dropped
 * (PRD §8). Read-only: no enable/disable control exists.
 */
const SCOPES = [
  { key: "system", label: "System scope", icon: MonitorCog },
  { key: "project", label: "Project scope", icon: FolderCog },
] as const;

interface Stats {
  total: number;
  enabled: number;
  notInIndex: number;
  contextCostly: number;
}

function computeStats(items: InventoryItemDto[]): Stats {
  let enabled = 0;
  let notInIndex = 0;
  let contextCostly = 0;
  for (const i of items) {
    if (i.enabled) enabled += 1;
    if (i.resolved == null) notInIndex += 1;
    else if (i.resolved.contextCostFlag) contextCostly += 1;
  }
  return { total: items.length, enabled, notInIndex, contextCostly };
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

  return (
    <section className="space-y-6" aria-label="Installed inventory status">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Installed inventory</h2>
        <p className="text-sm text-muted-foreground">
          Reconciled snapshot of what is installed, grouped by scope. Read-only — this
          mirrors <span className="font-mono">ccharness status</span>.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Installed" value={stats.total} icon={MonitorCog} />
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

      {SCOPES.map(({ key, label, icon: Icon }) => {
        const group = data.items.filter((i) => i.scope === key);
        if (group.length === 0) return null;
        return (
          <Card key={key}>
            <CardHeader className="flex-row items-center gap-2 space-y-0 py-3">
              <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
              <CardTitle className="text-sm">{label}</CardTitle>
              <Badge variant="info" className="ml-1 font-normal">
                {group.length}
              </Badge>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {group.map((item) => (
                  <StatusRow key={`${key}:${item.componentRef}`} item={item} />
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}

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
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <span className="flex min-w-0 items-center gap-2.5">
        {item.enabled ? (
          <Badge variant="official">
            <Power className="h-3 w-3" aria-hidden />
            on
          </Badge>
        ) : (
          <Badge variant="community">
            <PowerOff className="h-3 w-3" aria-hidden />
            off
          </Badge>
        )}
        <span className="truncate font-mono text-sm">{item.componentRef}</span>
      </span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {item.resolved == null ? (
          <Badge variant="warn">
            <CircleSlash className="h-3 w-3" aria-hidden />
            not in index
          </Badge>
        ) : (
          <>
            <Badge variant={item.resolved.trustTier}>{item.resolved.trustTier}</Badge>
            <span className="hidden sm:inline">
              {categoriesOf(item.resolved.categoryTags).join(", ")}
            </span>
            {item.resolved.contextCostFlag && (
              <Badge variant="warn">
                <Zap className="h-3 w-3" aria-hidden />
                cost
              </Badge>
            )}
          </>
        )}
      </span>
    </li>
  );
}

const ACCENTS = {
  default: "text-foreground",
  primary: "text-primary",
  warn: "text-amber-600 dark:text-amber-400",
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <Skeleton key={i} className="h-[88px] w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
