import {
  AlertCircle,
  CircleAlert,
  Download,
  Gauge,
  Info,
  Loader2,
  Power,
  PowerOff,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import {
  type AnnotationDto,
  type RecLineDto,
  type RecommendationDto,
  fetchRecommendation,
} from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

/**
 * Recommendation view (PRD §4.6): a task input that calls the SAME core
 * `recommend()` via the read-only API and renders enable/install/disable with
 * per-line reasons, conflict flags, and the context-cost summary. Output for a
 * given task matches `ccharness recommend "<task>"` exactly (PRD §4.6 exit gate).
 *
 * Acting on the result is a CLI step — this view only renders advice, it changes
 * nothing. Paid providers are declined server-side (PRD §4.8); the resulting
 * 402 message is surfaced plainly.
 */
const ACTION_META: Record<
  RecLineDto["action"],
  { variant: "official" | "partner" | "warn"; icon: typeof Power; label: string }
> = {
  enable: { variant: "official", icon: Power, label: "enable" },
  install: { variant: "partner", icon: Download, label: "install" },
  disable: { variant: "warn", icon: PowerOff, label: "disable" },
};

const SEVERITY_META: Record<
  AnnotationDto["severity"],
  { variant: "info" | "warn" | "destructive"; icon: typeof Info }
> = {
  info: { variant: "info", icon: Info },
  warn: { variant: "warn", icon: TriangleAlert },
  conflict: { variant: "destructive", icon: CircleAlert },
};

export function RecommendView(): React.JSX.Element {
  const [task, setTask] = React.useState("");
  const [scope, setScope] = React.useState<"system" | "project">("system");
  const [tight, setTight] = React.useState(false);
  const [provider, setProvider] = React.useState<"" | "anthropic" | "local">("");
  const [rec, setRec] = React.useState<RecommendationDto | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function run(): Promise<void> {
    if (!task.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchRecommendation({
        task,
        scope,
        tight,
        ...(provider ? { provider } : {}),
      });
      setRec(res.recommendation);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setRec(null);
    } finally {
      setLoading(false);
    }
  }

  const selectClass =
    "h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

  return (
    <section className="space-y-6" aria-label="Recommendation">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Recommendation</h2>
        <p className="text-sm text-muted-foreground">
          Describe your task to get install/enable/disable advice. This renders the same
          output as <span className="font-mono">ccharness recommend</span> — acting on it is a
          CLI step.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <Textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Describe what you're working on…"
            aria-label="Task description"
            rows={3}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
            }}
          />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <span>Scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "system" | "project")}
                aria-label="Scope"
                className={selectClass}
              >
                <option value="system">system</option>
                <option value="project">project</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <input
                type="checkbox"
                checked={tight}
                onChange={(e) => setTight(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              <span>Keep context tight</span>
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <span>Provider</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as "" | "anthropic" | "local")}
                aria-label="Provider"
                className={selectClass}
              >
                <option value="">default</option>
                <option value="local">local</option>
                <option value="anthropic">anthropic (CLI only)</option>
              </select>
            </label>
            <Button onClick={run} disabled={loading || !task.trim()} className="ml-auto">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden />
              )}
              {loading ? "Recommending…" : "Recommend"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Recommendation failed</AlertTitle>
          <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {loading && !error && <RecommendSkeleton />}

      {rec && !loading && <RecommendationResult rec={rec} />}
    </section>
  );
}

function RecommendationResult({ rec }: { rec: RecommendationDto }): React.JSX.Element {
  const s = rec.contextCostSummary;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="font-mono">
          provider: {rec.provider}
        </Badge>
        {rec.cached && <Badge variant="info">cached</Badge>}
        <Badge variant="outline" className="font-mono">
          index {rec.indexVersion}
        </Badge>
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Recommended actions</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="p-0">
          {rec.lines.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No actions recommended.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rec.lines.map((line) => {
                const meta = ACTION_META[line.action];
                const Icon = meta.icon;
                return (
                  <li key={`${line.action}:${line.componentRef}`} className="space-y-1 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={meta.variant}>
                        <Icon className="h-3 w-3" aria-hidden />
                        {meta.label}
                      </Badge>
                      <span className="font-mono text-sm">{line.componentRef}</span>
                    </div>
                    <p className="pl-0.5 text-sm text-muted-foreground">{line.reason}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {rec.annotations.length > 0 && (
        <div className="space-y-2">
          {rec.annotations.map((a) => {
            const meta = SEVERITY_META[a.severity];
            const Icon = meta.icon;
            return (
              <Alert key={`${a.kind}:${a.message}`} variant={meta.variant}>
                <Icon aria-hidden />
                <AlertTitle className="flex items-center gap-2 capitalize">
                  {a.severity}
                  <Badge variant="outline" className="font-mono text-[10px] font-normal">
                    {a.kind}
                  </Badge>
                </AlertTitle>
                <AlertDescription>{a.message}</AlertDescription>
              </Alert>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0 py-3">
          <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle className="text-sm">Context-cost summary</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-2 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={s.costlyCount > 0 ? "warn" : "info"}>
              {s.costlyCount} context-costly
            </Badge>
            {s.tightRequested && <Badge variant="outline">tight context requested</Badge>}
          </div>
          <p className="text-muted-foreground">
            {s.costlyCount} context-costly component(s) in the proposed stack
            {s.tightRequested ? " (tight context requested)" : ""}.
          </p>
          {s.note && (
            <p className="text-amber-700 dark:text-amber-300">{s.note}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RecommendSkeleton(): React.JSX.Element {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        {Array.from({ length: 3 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <div key={i} className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="h-5 w-16 animate-pulse rounded-md bg-muted" />
              <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-3 w-72 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
