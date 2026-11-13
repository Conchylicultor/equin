import type { ReactElement, ReactNode } from "react";

/**
 * A message standing in for an op Gantt — its loading, failed, unavailable or
 * empty state. The Gantt is full-bleed (its rule strips span its box) and pads
 * its own rows (`px-lg`), so nothing around it opens a region: the message
 * opens one on the Gantt's own text edge, the same wherever the Gantt sits (a
 * bordered card, a profiling section, a pane body). A `Placeholder` / `Loading`
 * inside lands there by doing nothing (slice 3 of
 * research/2026-11-09-global-surface-owned-inset.md).
 */
export function GanttMessage({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return <div className="rail-x-lg">{children}</div>;
}
