import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        // Trust tiers + signals (semantic, theme-aware via color-mix-free HSL alpha).
        official:
          "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        partner: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300",
        community: "border-border bg-muted text-muted-foreground",
        warn: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
        conflict:
          "border-destructive/40 bg-destructive/15 text-destructive dark:text-red-300",
        info: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        disabled: "border-border bg-muted/50 text-muted-foreground opacity-70",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
