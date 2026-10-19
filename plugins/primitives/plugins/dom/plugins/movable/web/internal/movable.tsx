import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

export interface MovableProps {
  /**
   * The element the piece must stay inside — usually the box its `Pin` is
   * pinned to. `null` while it is not mounted yet: the piece is not draggable.
   */
  bounds: HTMLElement | null;
  children: ReactNode;
  className?: string;
}

interface Offset {
  x: number;
  y: number;
}

/** How far the pointer travels before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** The gap kept between the piece and the edge of its bounds. */
const EDGE_GAP_PX = 4;
/** Presses that belong to the control under them, never to the drag. */
const NOT_A_HANDLE =
  "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='slider']";

const HOME: Offset = { x: 0, y: 0 };

/**
 * A floating piece the user can drag off whatever it covers.
 *
 * Grab it anywhere: on its surface the drag starts at once; on a button it
 * starts only once the pointer travels {@link DRAG_THRESHOLD_PX}, so a plain
 * press is still a click — and the release that ends a drag is swallowed, so
 * it never also presses the button it started on. The pointer is captured when
 * the drag starts, so it keeps following over an iframe. The offset is a
 * `transform` on this wrapper, leaving the positioning of whatever places it
 * (a `Pin`'s anchor and centring) untouched.
 *
 * It stays inside `bounds` (measured from where the piece sits at home), is
 * pulled back in when `bounds` resizes, and a double-click on its surface
 * sends it home.
 */
export function Movable({
  bounds,
  children,
  className,
}: MovableProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<Offset>(HOME);
  const [dragging, setDragging] = useState(false);
  const [homing, setHoming] = useState(false);
  // The offset as drawn, for the DOM handlers: the piece's home box is its
  // measured box minus it.
  const offsetRef = useLatestRef(offset);

  // A smaller window (or bounds) pulls a piece that would fall outside back in.
  useResizeObserver(
    () => bounds,
    () => {
      const el = ref.current;
      if (!el || !bounds) return;
      const now = offsetRef.current;
      const next = clampOffset(el, bounds, now, now);
      if (next.x !== now.x || next.y !== now.y) setOffset(next);
    },
    { deps: [bounds] },
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (e.button !== 0 || !el || !bounds) return;
    if (!(e.target instanceof Element) || e.target.closest(NOT_A_HANDLE))
      return;
    const onControl = e.target.closest("button, a, [role='button']") !== null;
    // On the bare surface, keep the press from selecting text as it moves.
    if (!onControl) e.preventDefault();
    const pointerId = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const from = offsetRef.current;
    let live = false;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!live) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        live = true;
        // Captured only now: captured from the press, the release would land on
        // this wrapper and the button's click would never fire.
        el.setPointerCapture(pointerId);
        setHoming(false);
        setDragging(true);
      }
      setOffset(
        clampOffset(el, bounds, offsetRef.current, {
          x: from.x + dx,
          y: from.y + dy,
        }),
      );
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!live) return;
      setDragging(false);
      // The click this release dispatches belongs to the drag, not to the
      // button it started on. It is dispatched in the same task, so the
      // swallow is gone before any later click.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true });
      setTimeout(
        () => window.removeEventListener("click", swallow, { capture: true }),
        0,
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onDoubleClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(`button, a, [role='button'], ${NOT_A_HANDLE}`)) return;
    if (offsetRef.current.x === 0 && offsetRef.current.y === 0) return;
    setHoming(true);
    setOffset(HOME);
  }

  return (
    <div
      ref={ref}
      className={cn(
        "touch-none",
        dragging ? "cursor-grabbing select-none" : "cursor-grab",
        homing && "transition-transform duration-300 ease-out",
        className,
      )}
      style={
        offset.x === 0 && offset.y === 0
          ? undefined
          : { transform: `translate(${offset.x}px, ${offset.y}px)` }
      }
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onTransitionEnd={() => setHoming(false)}
    >
      {children}
    </div>
  );
}

/**
 * `wanted`, limited so the piece stays inside `bounds`. The piece's home box is
 * its current box minus the offset it is drawn at (`current`).
 */
function clampOffset(
  el: HTMLElement,
  bounds: HTMLElement,
  current: Offset,
  wanted: Offset,
): Offset {
  const box = el.getBoundingClientRect();
  const room = bounds.getBoundingClientRect();
  const left = box.left - current.x;
  const top = box.top - current.y;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.round(Math.max(lo, Math.min(Math.max(lo, hi), v)));
  return {
    x: clamp(
      wanted.x,
      room.left + EDGE_GAP_PX - left,
      room.right - EDGE_GAP_PX - (left + box.width),
    ),
    y: clamp(
      wanted.y,
      room.top + EDGE_GAP_PX - top,
      room.bottom - EDGE_GAP_PX - (top + box.height),
    ),
  };
}
