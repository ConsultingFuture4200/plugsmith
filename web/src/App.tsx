import { Boxes, ListChecks, Sparkles, Terminal } from "lucide-react";
import type * as React from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IndexView } from "@/views/IndexView";
import { RecommendView } from "@/views/RecommendView";
import { StatusView } from "@/views/StatusView";

/**
 * Read-only dashboard shell (PRD §4.6). Three views — Index, Status,
 * Recommendation — over the same `@plugsmith/core` data the CLI uses. No view
 * performs a state change; every recommendation on screen is reproducible from
 * `plugsmith recommend`.
 */
const TABS = [
  { key: "index", label: "Index", icon: Boxes },
  { key: "status", label: "Status", icon: ListChecks },
  { key: "recommend", label: "Recommendation", icon: Sparkles },
] as const;

export function App(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
                <Terminal className="h-4 w-4" aria-hidden />
              </span>
              <div className="leading-tight">
                <h1 className="font-semibold tracking-tight">plugsmith</h1>
                <p className="text-xs text-muted-foreground">
                  read-only dashboard &middot; views only, no state changes
                </p>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </header>

        <Tabs defaultValue="index" className="mx-auto max-w-6xl px-6 py-6">
          <TabsList aria-label="Dashboard sections">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                <t.icon className="h-3.5 w-3.5" aria-hidden />
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <main className="mt-6">
            <TabsContent value="index" className="focus-visible:outline-none">
              <IndexView />
            </TabsContent>
            <TabsContent value="status" className="focus-visible:outline-none">
              <StatusView />
            </TabsContent>
            <TabsContent value="recommend" className="focus-visible:outline-none">
              <RecommendView />
            </TabsContent>
          </main>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}
