import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";
import {
  scoreEndBeat,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { railBand } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import {
  pct,
  Placed,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  useHoverReveal,
  hoverRevealClass,
} from "@plugins/primitives/plugins/hover-reveal/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { snapToBars } from "../loop-actions";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");

/** The handles and the outside-shade stand this far proud of the hot rail. */
const HANDLE_BAND = railBand(3);
const SHADE_BAND = railBand(1);

/**
 * The A–B practice-loop region marker, drawn in the rail zone. The loop
 * `[start, end]` is a rounded band covering the zone (a little taller than the
 * rail), with a draggable accent pill on the rail at A and at B, the rail
 * outside `[A, B]` dimmed while the loop is enabled, and a hover-revealed clear
 * button above the band's top-right.
 *
 * Pointer model (load-bearing): the marker layer the scrubber hosts is
 * `pointer-events-none`, so clicks fall through to the seek track. The root and
 * the shades stay pointer-transparent; the band is interactive only for hover
 * (revealing the clear button) and does NOT stop propagation, so a click
 * inside the loop still seeks. Only the handles (drag) and the clear button
 * `stopPropagation()` their `pointerdown`, so grabbing them never also fires
 * the parent slider's `seekToPointer`.
 *
 * Beat projection: handle drags read the root's `getBoundingClientRect()` and
 * map `clientX` exactly the way the scrubber's `seekToPointer` does
 * (`(x - left) / width * endBeat`), snapped to bar lines unless Alt is held.
 * `setLoop` clamps + enforces the min-gap, so the handles can never cross.
 */
export function LoopRegion({
  score,
  beatToFraction,
}: {
  score: Score;
  beatToFraction: (beat: number) => number;
}) {
  const { loop, setLoop } = useSession();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { revealed, groupProps } = useHoverReveal();

  const endBeat = scoreEndBeat(score);
  // No region (or nothing to anchor to) → render nothing.
  if (!loop || endBeat <= 0) return null;

  const startF = beatToFraction(loop.start);
  const endF = beatToFraction(loop.end);
  const widthF = Math.max(0, endF - startF);

  // clientX → beat, using the SAME projection as the scrubber's seek. Snaps to
  // bar lines unless Alt is held for fine placement.
  const beatFromClientX = (clientX: number, altKey: boolean): number => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const f = (clientX - rect.left) / rect.width;
    const beat = Math.max(0, Math.min(1, f)) * endBeat;
    return altKey ? beat : snapToBars(beat, score);
  };

  const startHandleDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.buttons & 1) === 0) return;
    setLoop({ ...loop, start: beatFromClientX(e.clientX, e.altKey) });
  };
  const endHandleDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.buttons & 1) === 0) return;
    setLoop({ ...loop, end: beatFromClientX(e.clientX, e.altKey) });
  };

  const grabPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  return (
    <Layer ref={rootRef} decorative>
      {/* While enabled, dim the rail outside [A, B] (pointer-transparent). */}
      {loop.enabled && (
        <>
          <Placed
            x={{ start: 0, size: pct(startF) }}
            y={SHADE_BAND}
            className="bg-background/60"
          />
          <Placed
            x={{ start: pct(endF), end: 0 }}
            y={SHADE_BAND}
            className="bg-background/60"
          />
        </>
      )}

      {/* The loop band [A, B] over the rail zone. Interactive only so hovering
          reveals the clear button — no stopPropagation, so a click inside it
          still seeks. Transparent with a faint ring while disabled, so the
          bounds stay visible during a play-through. */}
      <Placed
        {...groupProps}
        x={{ start: pct(startF), size: pct(widthF) }}
        y="fill"
        className={cn(
          "pointer-events-auto rounded-md",
          loop.enabled
            ? "bg-primary/15 ring-1 ring-inset ring-primary/45"
            : "opacity-70 ring-1 ring-inset ring-primary/35",
        )}
        title={loop.enabled ? "Loop A–B" : "Loop A–B (off)"}
      >
        {/* Hover-revealed clear button, pinned above the band's top-right. It
            must re-enable pointer events explicitly (the marker layer is
            pointer-events-none) AND only while revealed — hoverRevealClass owns
            the opacity↔pointer-events coupling, we add the auto needed to punch
            through the inert ancestor only in the revealed branch. */}
        <Placed
          x={{ end: 0 }}
          y={{ start: 0, shift: "-100%" }}
          className={cn(
            hoverRevealClass(revealed),
            revealed && "pointer-events-auto",
          )}
        >
          <ControlSizeProvider size="xs">
            <IconButton
              icon={closeIcon}
              label="Clear loop"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setLoop(null)}
            />
          </ControlSizeProvider>
        </Placed>
      </Placed>

      {/* Edge handles on the rail. Each is a wide invisible hit area with a
          4px accent pill; pointer-capture keeps the drag tracking off the
          handle. */}
      <Placed
        onPointerDown={grabPointer}
        onPointerMove={startHandleDrag}
        x={{ center: pct(startF), size: 14 }}
        y={HANDLE_BAND}
        className="pointer-events-auto cursor-ew-resize"
        aria-label="Loop start"
      >
        <Placed
          x={{ center: "50%", size: 4 }}
          y="fill"
          className={cn(
            "rounded-full bg-primary",
            !loop.enabled && "opacity-50",
          )}
        />
      </Placed>
      <Placed
        onPointerDown={grabPointer}
        onPointerMove={endHandleDrag}
        x={{ center: pct(endF), size: 14 }}
        y={HANDLE_BAND}
        className="pointer-events-auto cursor-ew-resize"
        aria-label="Loop end"
      >
        <Placed
          x={{ center: "50%", size: 4 }}
          y="fill"
          className={cn(
            "rounded-full bg-primary",
            !loop.enabled && "opacity-50",
          )}
        />
      </Placed>
    </Layer>
  );
}
