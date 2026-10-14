import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useMemo, useRef } from "react";
import type { Projection } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEdgeAutoScroll } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { snapToBars } from "../loop-actions";
import { useLoopEdgeBuckets } from "../loop-edge-state";
import { loopOccurrences } from "../loop-occurrences";

/** Height (px) of the invisible grab strip centred on each boundary line. */
const HANDLE_HIT_PX = 12;

/**
 * How close (px) to the lane's top or bottom edge a dragged boundary starts
 * scrolling the roll. A little under the primitive's default, since a boundary
 * sitting on the playhead is grabbed right at the lane's bottom edge.
 */
const EDGE_SCROLL_PX = 40;

/** Pointer handlers that drag one loop boundary; spread onto its grab targets. */
type BoundaryDragProps = {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
};

/**
 * The A–B practice loop, surfaced on the piano roll's falling-note timeline: a
 * band spanning `[A, B]` with a boundary line + letter label at each edge,
 * anchored to the time axis via the published `projection` and rendered inside
 * the display's scroll layer — so it scrolls glued to the notes (A/B fall toward
 * the now-line exactly as the music reaches them).
 *
 * Both boundaries are draggable here too, not only on the progression bar: a
 * full-width grab strip over each line (and its letter chip) moves that bound,
 * snapped to bar lines unless Alt is held — the same rule as the bar's handles.
 * Everything else stays pointer-transparent, so a drag anywhere else on the lane
 * still scrubs the song. The grab targets `stopPropagation()` their
 * `pointerdown` so grabbing a boundary never also starts the lane's scrub.
 *
 * Holding a dragged boundary near the lane's top or bottom edge scrolls the
 * roll (later / earlier in the song), so a bound can be carried past what is on
 * screen. The roll scrolls by moving the playhead, so the edge auto-scroll gets
 * a surface whose `scrollBy` seeks; playback pauses while it scrolls and
 * resumes on release, like the lane's own drag.
 *
 * Mirrors the progress-bar `LoopRegion`'s visual language (primary tint + ring;
 * faded / outline-only while disabled) so the same loop reads as the same thing
 * on both surfaces.
 *
 * When the display unrolls the loop ahead (`projection.timeline.loop`), the
 * band repeats on every drawn copy of the loop ({@link loopOccurrences}), so
 * past B the boundaries read where the repeats really are — each copy's band
 * sitting after its rest. Every copy's boundaries drag too: a copy maps a
 * pointer back to the loop by its own offset.
 *
 * Beat ↔ Y projection: `projection.beatToY` is CONTENT-space and negative for
 * positive beats (future = more negative = higher up). `B` (end) is further in
 * the future than `A` (start), so `beatToY(end) < beatToY(start)`: the band's
 * top is `beatToY(end)` and its height is `beatToY(start) - beatToY(end)`. A
 * drag maps back with `projection.yToBeat`, measuring the pointer against this
 * layer's own top edge — the content origin, wherever the scroll has put it.
 * Those are AXIS beats; the cursor is placed on the axis, and a scroll maps
 * back to a play position, through `projection.timeline`.
 */
export function LoopRollRegion({ projection }: { projection: Projection }) {
  const { loop, setLoop, score, seekTo, isPlaying, play, stop } = useSession();
  const cursor = useCursorApi();
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The boundary being dragged (and whether Alt is held for off-grid placement),
  // and whether this drag's edge scroll paused playback.
  const dragRef = useRef<{
    edge: "start" | "end";
    altKey: boolean;
    // The dragged occurrence's axis offset (0 = the loop itself, else a copy).
    shift: number;
  } | null>(null);
  const pausedRef = useRef(false);
  const { beatToY, yToBeat, timeline } = projection;
  const H = projection.viewport.height;
  const shifts = useMemo(() => loopOccurrences(projection), [projection]);
  // Which boundaries have scrolled off-screen (so their content-space label is
  // hidden — the screen-anchored edge chip stands in for it). Called BEFORE the
  // early return so hook order stays stable; it early-returns empty internally
  // when there's no loop / time axis.
  const { top: edgeTop, bottom: edgeBottom } = useLoopEdgeBuckets(projection);

  // Pointer → beat: the layer's top edge is content Y 0, so the pointer's
  // offset from it is a content-space Y. `setLoop` clamps and keeps the min
  // gap, so the boundaries can never cross.
  const moveDragged = useEventCallback((clientY: number) => {
    const drag = dragRef.current;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!drag || !rect || !loop || !yToBeat) return;
    const beat = yToBeat(clientY - rect.top) - drag.shift;
    setLoop({
      ...loop,
      [drag.edge]: drag.altKey ? beat : snapToBars(beat, score),
    });
  });

  // The roll as an edge-scroll surface. The playhead sits on the lane's bottom
  // edge, so the lane's top in the viewport is the content origin moved down by
  // the playhead's content Y, less the lane height (see `useLoopEdgeBuckets`).
  // Scrolling by `px` is a seek by that much content Y.
  const autoScroll = useEdgeAutoScroll({
    threshold: EDGE_SCROLL_PX,
    surface: () => {
      const root = rootRef.current;
      if (!root || !beatToY || !yToBeat || !timeline) return null;
      const cursorAxis = () => timeline.axisBeat(cursor.getPosition());
      return {
        band: () => {
          const top =
            root.getBoundingClientRect().top + beatToY(cursorAxis()) - H;
          return { top, bottom: top + H };
        },
        scrollBy: (px) => {
          if (isPlaying && !pausedRef.current) {
            pausedRef.current = true;
            stop();
          }
          const before = cursor.getBeat();
          seekTo(timeline.at(yToBeat(beatToY(cursorAxis()) + px)).beat);
          return cursor.getBeat() !== before;
        },
      };
    },
    // The content moved under a still pointer: re-place the boundary under it.
    onScroll: moveDragged,
  });

  // The drag's pointer handlers — event callbacks, since they drive refs.
  const startDrag = useEventCallback(
    (
      edge: "start" | "end",
      shift: number,
      e: ReactPointerEvent<HTMLDivElement>,
    ) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { edge, altKey: e.altKey, shift };
    },
  );
  const continueDrag = useEventCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || (e.buttons & 1) === 0) return;
      drag.altKey = e.altKey;
      moveDragged(e.clientY);
      autoScroll.track(e.clientY);
    },
  );
  const endDrag = useEventCallback(() => {
    dragRef.current = null;
    autoScroll.stop();
    if (pausedRef.current) {
      pausedRef.current = false;
      play();
    }
  });

  // No region, or a display without a real time axis → render nothing.
  if (!loop || !beatToY || !yToBeat) return null;

  const dragBoundary = (
    edge: "start" | "end",
    shift: number,
  ): BoundaryDragProps => ({
    onPointerDown: (e) => startDrag(edge, shift, e),
    onPointerMove: continueDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  });

  // A boundary is on-screen iff it's in neither edge bucket → show its labels.
  const aOn = !edgeTop.includes("A") && !edgeBottom.includes("A");
  const bOn = !edgeTop.includes("B") && !edgeBottom.includes("B");

  return (
    // Full-bleed, pointer-transparent: its top edge is the content origin the
    // drag measures against; only the grab strips and labels take the pointer.
    <Layer ref={rootRef} decorative>
      {shifts.map((shift) => (
        <LoopBand
          key={shift}
          yA={beatToY(loop.start + shift)}
          yB={beatToY(loop.end + shift)}
          enabled={loop.enabled}
          aOn={aOn}
          bOn={bOn}
          dragA={dragBoundary("start", shift)}
          dragB={dragBoundary("end", shift)}
        />
      ))}
    </Layer>
  );
}

/**
 * One occurrence of the loop on the axis: the `[A, B]` band, its two grab
 * strips and its letter labels.
 */
function LoopBand({
  yA,
  yB,
  enabled,
  aOn,
  bOn,
  dragA,
  dragB,
}: {
  /** Content Y of A — lower on screen (less negative). */
  yA: number;
  /** Content Y of B — higher on screen (more negative). */
  yB: number;
  enabled: boolean;
  aOn: boolean;
  bOn: boolean;
  dragA: BoundaryDragProps;
  dragB: BoundaryDragProps;
}) {
  return (
    <>
      {/* The [A, B] span, drawn as a TRANSPARENT outline — no fill, since a wash
          over the falling notes reads as distracting. The 2px border frames the
          region: the left/right edges are the "inside a loop" side rails, and the
          top/bottom edges are the B and A boundary lines (pixel-exact on the
          bounds, all in one element). Solid while looping; dashed while the loop
          is defined-but-disabled. */}
      <Placed
        x="fill"
        y={{ start: yB, size: Math.max(0, yA - yB) }}
        className={cn(
          "border-2",
          enabled ? "border-primary" : "border-dashed border-primary/45",
        )}
      />
      {/* Grab strips over the B (top) and A (bottom) boundary lines. */}
      <BoundaryHandle y={yB} label="Loop end (B)" drag={dragB} />
      <BoundaryHandle y={yA} label="Loop start (A)" drag={dragA} />
      {/* B label tucked just below its top edge; A label just above its bottom
          edge — both stay inside the band, clear of the lane edges. Each shows
          only while its boundary is on-screen; once a boundary scrolls past the
          lookahead the edge chip (LoopRollEdge) stands in for the label. Each
          label is a grab target for its boundary too. */}
      {bOn ? (
        <LoopLabel
          y={yB}
          label="B"
          enabled={enabled}
          side="below"
          drag={dragB}
        />
      ) : null}
      {aOn ? (
        <LoopLabel
          y={yA}
          label="A"
          enabled={enabled}
          side="above"
          drag={dragA}
        />
      ) : null}
    </>
  );
}

/**
 * The invisible full-width grab strip centred on one boundary line. Tints on
 * hover (with the resize cursor) so the line reads as something you can drag.
 */
function BoundaryHandle({
  y,
  label,
  drag,
}: {
  y: number;
  label: string;
  drag: BoundaryDragProps;
}) {
  return (
    <Placed
      {...drag}
      x="fill"
      y={{ center: y, size: HANDLE_HIT_PX }}
      className="pointer-events-auto cursor-ns-resize hover:bg-primary/25"
      aria-label={label}
      title={`${label} — drag to move, hold Alt to move off the bar lines`}
    />
  );
}

/**
 * A loop-boundary letter chip ("A" / "B"), pinned to the right edge at its
 * content-space `y` and offset just inside the band (`below` the top edge, or
 * `above` the bottom edge). Fades with the loop's enabled state. Also a grab
 * target for its boundary, the easier one to find than the thin line.
 */
function LoopLabel({
  y,
  label,
  enabled,
  side,
  drag,
}: {
  y: number;
  label: string;
  enabled: boolean;
  side: "above" | "below";
  drag: BoundaryDragProps;
}) {
  return (
    // Pinned to the right edge at a runtime content-space Y; the `shift` is what
    // keeps an "above" chip just inside the band rather than straddling it.
    <Placed
      {...drag}
      x={{ end: 0 }}
      y={{ start: y, shift: side === "above" ? "-100%" : undefined }}
      // eslint-disable-next-line text/no-adhoc-typography -- leading-none keeps the single-letter edge chip tight against the band
      className={cn(
        "pointer-events-auto cursor-ns-resize rounded-l-sm px-xs py-2xs text-2xs font-bold leading-none text-primary-foreground shadow-sm",
        enabled ? "bg-primary" : "bg-primary/55",
      )}
    >
      {label}
    </Placed>
  );
}
