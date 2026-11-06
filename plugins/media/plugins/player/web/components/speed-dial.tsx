import { useEffect, useRef, useState } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { DIAL_WHEEL_SETTLE_MS } from "../internal/geometry";
import {
  RATE_MAX,
  RATE_MIN,
  clickRate,
  dialTicks,
  dragRate,
  keyRate,
  rulerOffset,
  wheelRate,
} from "../internal/math";

/** Set the speed: `snap` settles onto the dial's step (animated); unsnapped follows a drag or wheel. */
export type SetRate = (rate: number, opts?: { snap?: boolean }) => void;

const TICKS = dialTicks();

/**
 * The speed dial: a ruler that slides under a fixed centre needle, 0.25× to
 * 3× in 0.05 steps — majors every 0.5 (labelled), mids every 0.25. Drag it,
 * wheel it, click a point on it, or use ← → (Home / End for the ends); every
 * gesture settles onto a step when it ends. The edges fade out.
 */
export function SpeedDial({
  rate,
  settle,
  setRate,
  focused,
}: {
  /** Take focus when this turns true — the panel opening — so ← → move the speed at once. */
  focused: boolean;
  rate: number;
  /** The last change was a snap: the ruler glides to it. */
  settle: boolean;
  setRate: SetRate;
}) {
  const [drag, setDrag] = useState<{
    x: number;
    rate: number;
    moved: boolean;
  } | null>(null);
  const wheelEl = useRef<HTMLDivElement | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const rateRef = useRef(rate);

  // The wheel must stay on the dial (not scroll the page), which a React
  // wheel handler cannot do: React's are passive.
  useEffect(() => {
    const el = wheelEl.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = wheelRate(rateRef.current, e.deltaX, e.deltaY);
      rateRef.current = next;
      setRate(next, { snap: false });
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(
        () => setRate(rateRef.current),
        DIAL_WHEEL_SETTLE_MS,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(settleTimer.current);
    };
  }, [setRate]);

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  // Once the panel is open (no longer inert), not before: an inert element
  // cannot take focus.
  useEffect(() => {
    if (focused) wheelEl.current?.focus({ preventScroll: true });
  }, [focused]);

  // The drag's truth for the handlers: a release fires pointerup then
  // lostpointercapture in one task, before `drag` re-renders.
  const dragNow = useRef(false);

  const end = (clientX: number, box: DOMRect) => {
    if (drag === null || !dragNow.current) return;
    dragNow.current = false;
    if (!drag.moved)
      setRate(clickRate(rate, clientX - (box.left + box.width / 2)));
    else setRate(rate);
    setDrag(null);
  };

  // The capture ended without a release (cancelled, or taken by the
  // browser): no click to read, so a drag just settles where it is.
  const settleDrag = () => {
    if (drag === null || !dragNow.current) return;
    dragNow.current = false;
    setRate(rate);
    setDrag(null);
  };

  return (
    <div
      ref={wheelEl}
      className="mp-dial"
      role="slider"
      tabIndex={0}
      aria-label="Playback speed"
      aria-valuemin={RATE_MIN}
      aria-valuemax={RATE_MAX}
      aria-valuenow={+rate.toFixed(2)}
      data-dragging={drag !== null || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragNow.current = true;
        setDrag({ x: e.clientX, rate, moved: false });
      }}
      onPointerMove={(e) => {
        if (drag === null || !dragNow.current) return;
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 2 && !drag.moved) setDrag({ ...drag, moved: true });
        setRate(dragRate(drag.rate, dx), { snap: false });
      }}
      onPointerUp={(e) =>
        end(e.clientX, e.currentTarget.getBoundingClientRect())
      }
      onPointerCancel={settleDrag}
      onLostPointerCapture={settleDrag}
      onKeyDown={(e) => {
        const next = keyRate(rate, e.key);
        if (next === null) return;
        // The dial's own arrows: the player's ← → (seek) must not also fire.
        e.preventDefault();
        e.stopPropagation();
        setRate(next);
      }}
    >
      <div
        className="mp-ruler"
        data-settle={settle || undefined}
        style={{ transform: `translateX(${rulerOffset(rate)}px)` }}
      >
        {TICKS.map((t) => (
          <Tick key={t.rate} x={t.x} kind={t.kind} rate={t.rate} />
        ))}
      </div>
      <div className="mp-needle" />
    </div>
  );
}

function Tick({
  x,
  kind,
  rate,
}: {
  x: number;
  kind: "major" | "mid" | "minor";
  rate: number;
}) {
  return (
    <>
      <div className="mp-tick" data-kind={kind} style={{ left: x }} />
      {kind === "major" && (
        <Text
          className="mp-tick-label text-2xs tabular-nums"
          style={{ left: x }}
        >
          {rate}×
        </Text>
      )}
    </>
  );
}
