import { useRef, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

/** The edge margin a popover keeps from the desktop's sides (mockup: 8px). */
const EDGE = 8;

/**
 * A panel floating above a shelf element — the peek thumbnails, the app-name
 * tip, the desktop preview: centred over `anchor`, `gap` px above it, clamped
 * {@link EDGE}px inside the desktop's sides (mockup `showPeek`).
 *
 * Drawn in the shelf's own layer rather than portalled: it sits in the
 * desktop's theme and stacking order with the dock, and its position is the
 * anchor's rect relative to that layer. The panel re-places itself whenever
 * its size changes (the snapshots inside size themselves on mount), with a
 * synchronous observer so it is never painted at a stale spot.
 */
export function ShelfPopover({
  anchor,
  layer,
  gap,
  className,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  anchor: HTMLElement;
  /** The positioned layer the popover is placed in. */
  layer: HTMLElement;
  gap: number;
  className?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useResizeObserver(
    ref,
    () => {
      const el = ref.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const l = layer.getBoundingClientRect();
      const w = el.offsetWidth;
      const left = Math.max(
        EDGE,
        Math.min(a.left - l.left + a.width / 2 - w / 2, l.width - w - EDGE),
      );
      el.style.left = `${left}px`;
      el.style.top = `${a.top - l.top - el.offsetHeight - gap}px`;
    },
    { debounce: false, deps: [anchor, layer, gap] },
  );

  return (
    <div
      ref={ref}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // eslint-disable-next-line layout/no-adhoc-layout -- a popover placed at measured pixel coordinates over the shelf; `left`/`top` are written by the observer above
      className={cn(
        "pointer-events-auto absolute left-0 top-0 w-max max-w-[calc(100%-16px)] text-popover-foreground",
        // The mockup's frosted menu glass (`--menu-bg` + blur 30 saturate 1.8)
        // and its popover lift; no token spells this shadow.
        "bg-popover/90 backdrop-blur-[30px] backdrop-saturate-[1.8]",
        "shadow-[0_0_0_0.5px_var(--input),0_16px_40px_-10px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.08)]",
        "animate-in fade-in-0 slide-in-from-bottom-1 zoom-in-98 duration-[140ms] ease-[cubic-bezier(.2,.8,.2,1)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
