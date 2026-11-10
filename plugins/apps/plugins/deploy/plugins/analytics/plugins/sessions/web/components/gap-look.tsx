import type { ReactNode } from "react";
import type { GapKind } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/** How a stretch away is named: in a tooltip or a timeline line, and in the legend. */
export const GAP_LABEL: Record<GapKind, { label: string; legend: string }> = {
  hidden: { label: "Tab in the background", legend: "Background" },
  idle: { label: "Idle", legend: "Idle" },
};

/**
 * How a stretch away is drawn, everywhere it is drawn (the bar, the legend,
 * the timeline's icon): background = the bar emptied to the card, a dashed
 * line through its middle; idle = a hatch over the page's own fill.
 */
export const GAP_FILL: Record<GapKind, string> = {
  hidden:
    "bg-card bg-[image:repeating-linear-gradient(90deg,color-mix(in_oklab,var(--faint-foreground)_60%,transparent)_0_4px,transparent_4px_8px)] bg-[length:100%_1px] bg-center bg-no-repeat",
  idle: "bg-[image:repeating-linear-gradient(135deg,color-mix(in_oklab,var(--faint-foreground)_48%,transparent)_0_1.5px,transparent_1.5px_6px)]",
};

/** A small sample of a stretch's look, on the page fill: the legend's and the timeline's mark. */
export function GapSwatch({
  kind,
  className,
}: {
  kind: GapKind;
  className: string;
}): ReactNode {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block bg-muted shadow-[inset_0_0_0_1px_var(--border)]",
        GAP_FILL[kind],
        className,
      )}
    />
  );
}
