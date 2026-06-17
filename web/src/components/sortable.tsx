import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Lightweight client-side table sorting. Pure presentation over data the API
 * already returned (no new logic; the read-only boundary holds). A column maps
 * to a comparator; clicking its header toggles asc → desc → asc.
 */
export type SortDir = "asc" | "desc";
export interface SortState {
  key: string | null;
  dir: SortDir;
}

export type Comparators<T> = Record<string, (a: T, b: T) => number>;

export function useSort<T>(
  rows: T[],
  comparators: Comparators<T>,
  initial: SortState = { key: null, dir: "asc" },
): { sorted: T[]; state: SortState; toggle: (key: string) => void } {
  const [state, setState] = React.useState<SortState>(initial);

  const sorted = React.useMemo(() => {
    const { key, dir } = state;
    const cmp = key ? comparators[key] : undefined;
    if (!cmp) return rows;
    return [...rows].sort((a, b) => (dir === "asc" ? cmp(a, b) : cmp(b, a)));
  }, [rows, state, comparators]);

  const toggle = React.useCallback((key: string) => {
    setState((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }, []);

  return { sorted, state, toggle };
}

/** A sortable column header. Renders an accessible toggle button with a direction caret. */
export function SortableHead({
  label,
  sortKey,
  state,
  onSort,
  className,
  align = "left",
}: {
  label: string;
  sortKey: string;
  state: SortState;
  onSort: (key: string) => void;
  className?: string;
  align?: "left" | "right";
}): React.JSX.Element {
  const active = state.key === sortKey;
  const Icon = !active ? ChevronsUpDown : state.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (state.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <Icon
          className={cn("h-3.5 w-3.5 shrink-0", active ? "text-foreground" : "text-muted-foreground/50")}
          aria-hidden
        />
      </button>
    </TableHead>
  );
}
