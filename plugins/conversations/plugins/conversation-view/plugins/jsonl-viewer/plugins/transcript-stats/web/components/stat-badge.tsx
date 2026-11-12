import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import type { Tooltipped } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  WithHoverCard,
  type HoverCardContent,
} from "@plugins/primitives/plugins/overlay/plugins/hover-card/web";

/** How loud a stat is. `attention` / `alert` change the ink, never the plate. */
export type StatTone = "muted" | "attention" | "alert";

// One translucent plate for every stat, so the strip reads as one row of
// readings rather than a pile of differently-styled chips. Tone is the only
// axis a contribution gets, and it moves the ink alone — a status strip that
// starts painting filled colour blocks over the transcript is exactly the
// noise this strip exists to avoid.
const PLATE = "bg-background/80 backdrop-blur-sm";
const INK: Record<StatTone, string> = {
  muted: "text-muted-foreground/60",
  attention: "text-warning",
  alert: "text-destructive",
};

/**
 * Hover detail: `card` for the exact figures behind the rounded ones (a hover
 * card, so several numbers read as a table, not a run-on line); `tooltip` for
 * a one-line label. Never both.
 */
export interface StatBadgeProps extends Tooltipped, Passthrough {
  tone?: StatTone;
  card?: HoverCardContent;
  /**
   * `"button"` for a stat that opens something (a popover trigger spreads its
   * handlers and ref onto the badge, which is why the rest passes through).
   */
  as?: "span" | "button";
  children: ReactNode;
}

export function StatBadge({
  tone = "muted",
  as = "span",
  card,
  children,
  ...rest
}: StatBadgeProps) {
  if (card !== undefined && rest.tooltip != null)
    throw new Error("StatBadge: pass `card` or `tooltip`, not both.");
  const badge = (
    <Badge
      as={as}
      colorClass={`${PLATE} ${INK[tone]}`}
      className={cn(
        "pointer-events-auto",
        as === "button" && "cursor-pointer hover:text-foreground",
      )}
      {...(as === "button" ? { type: "button" } : {})}
      {...rest}
    >
      {children}
    </Badge>
  );
  if (card === undefined) return badge;
  return <WithHoverCard card={card}>{badge}</WithHoverCard>;
}
