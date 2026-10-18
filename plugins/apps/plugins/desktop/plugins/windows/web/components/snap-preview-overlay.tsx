import { snapBox, useSnapPreview } from "../hooks/use-snap";
import { useWorkAreaReserve } from "../internal/work-area";

/**
 * The mockup's `#snap-ghost` look: an accent-tinted frosted pane with an accent
 * rim, gliding between zones. Literals on purpose — the mockup's own mix of the
 * accent with white glass, which no theme token expresses.
 */
const GHOST_STYLE = {
  borderRadius: 12,
  background:
    "color-mix(in oklab, var(--primary) 16%, rgba(255, 255, 255, 0.25))",
  border: "1.5px solid color-mix(in oklab, var(--primary) 65%, white)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  transition: [
    "left 160ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    "top 160ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    "width 160ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    "height 160ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    "opacity 120ms",
  ].join(", "),
} as const;

/**
 * The live snap-zone ghost: where the dragged window will land, painted over
 * the desktop while a titlebar drag hovers an armed edge/corner. Rendered as
 * part of the floating placement's `Foreground` (a sibling above all window
 * containers), inside the desktop's theme (its accent). It positions itself with
 * the SAME `snapBox` the snapped window will adopt — inside the work area — so
 * the ghost is pixel-faithful to the result. Always mounted once a zone was
 * armed: it fades in and out and slides between zones.
 */
export function SnapPreviewOverlay() {
  const { zone, shown } = useSnapPreview();
  const reserve = useWorkAreaReserve();
  if (!zone) return null;
  return (
    <div
      aria-hidden
      // eslint-disable-next-line layout/no-adhoc-layout -- transient snap-zone ghost; positioned from snapBox(), no positioning primitive applies
      className="pointer-events-none absolute z-float"
      style={{
        ...snapBox(zone, reserve),
        ...GHOST_STYLE,
        opacity: shown ? 1 : 0,
      }}
    />
  );
}
