import type React from "react";
import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Pin,
  type PinAnchor,
} from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  Placed,
  type Extent,
  type PlacedOptions,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import type { SpaceStep } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import type { InTreeLayer } from "@plugins/primitives/plugins/css/plugins/z-layers/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { NOT_A_HANDLE, useDragGesture } from "./use-drag-gesture";

/**
 * Where the piece sits at home — by a ramp step, as a `Pin` (`{ pin: "bottom",
 * offset: "lg" }`), or by runtime coordinates, as a `Placed` (`{ x, y }`).
 * Both write the CSS `translate` property for their centring, so they compose
 * with the drag's `transform`.
 */
export type MovableAt =
  | { pin: PinAnchor; offset?: SpaceStep; layer?: InTreeLayer }
  | ({ x: Extent; y: Extent } & PlacedOptions);

/**
 * The movable piece IS the positioned element: `at` places it, and the drag
 * moves that same box — the one that is hit-tested. There is no separate
 * positioned wrapper to stay behind at home and swallow the clicks of whatever
 * is under the place the piece left.
 */
export interface MovableProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "onPointerDown" | "onDoubleClick" | "onTransitionEnd"
> {
  at: MovableAt;
  /**
   * The element the piece must stay inside — usually the box it is placed in.
   * `null` while it is not mounted yet: the piece is not draggable.
   */
  bounds: HTMLElement | null;
  children: ReactNode;
}

interface Offset {
  x: number;
  y: number;
}

/** The gap kept between the piece and the edge of its bounds. */
const EDGE_GAP_PX = 4;

const HOME: Offset = { x: 0, y: 0 };

/**
 * A floating piece the user can drag off whatever it covers.
 *
 * Grab it anywhere: on its surface the drag starts at once; on a button it
 * starts only once the pointer travels a few px (`useDragGesture`), so a plain
 * press is still a click — and the release that ends a drag is swallowed, so
 * it never also presses the button it started on. The pointer is captured when
 * the drag starts, so it keeps following over an iframe.
 *
 * It is the positioned element itself (`at`: a `Pin` step or `Placed`
 * coordinates), and the offset is a `transform` on that same element,
 * composing with the placement's `translate` centring. One box: once moved,
 * nothing is left at home to eat the clicks of what it used to cover.
 *
 * It stays inside `bounds` (measured from where the piece sits at home), is
 * pulled back in when `bounds` resizes, and a double-click on its surface
 * sends it home.
 */
export function Movable({
  at,
  bounds,
  children,
  className,
  style,
  ...rest
}: MovableProps): ReactElement {
  const ref = useRef<HTMLElement>(null);
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

  // The offset the live drag started from.
  const from = useRef<Offset>(HOME);
  const startDrag = useDragGesture({
    onStart: () => {
      from.current = offsetRef.current;
      setHoming(false);
      setDragging(true);
    },
    onMove: ({ dx, dy }) => {
      const el = ref.current;
      if (!el || !bounds) return;
      setOffset(
        clampOffset(el, bounds, offsetRef.current, {
          x: from.current.x + dx,
          y: from.current.y + dy,
        }),
      );
    },
    onEnd: () => setDragging(false),
  });
  function onPointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (!bounds) return;
    startDrag(e);
  }

  function onDoubleClick(e: ReactMouseEvent<HTMLElement>) {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(`button, a, [role='button'], ${NOT_A_HANDLE}`)) return;
    if (offsetRef.current.x === 0 && offsetRef.current.y === 0) return;
    setHoming(true);
    setOffset(HOME);
  }

  const piece = {
    ...rest,
    ref,
    className: cn(
      "touch-none",
      dragging ? "cursor-grabbing select-none" : "cursor-grab",
      homing && "transition-transform duration-300 ease-out",
      className,
    ),
    // The offset is `transform`; the placement's own centring is the separate
    // `translate` property, so the two compose.
    style:
      offset.x === 0 && offset.y === 0
        ? style
        : { ...style, transform: `translate(${offset.x}px, ${offset.y}px)` },
    onPointerDown,
    onDoubleClick,
    onTransitionEnd: () => setHoming(false),
    children,
  };
  return "pin" in at ? (
    <Pin to={at.pin} offset={at.offset} layer={at.layer} {...piece} />
  ) : (
    <Placed
      x={at.x}
      y={at.y}
      layer={at.layer}
      decorative={at.decorative}
      {...piece}
    />
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
