import { useRef, useState, type PointerEvent } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { clamp, formatTime, fractionAt, seekKeyTarget } from "../internal/math";

export interface SeekBarProps {
  currentTime: number;
  duration: number;
  buffered: number;
  /** Move the playhead (seconds). */
  onSeek(time: number): void;
  /** A drag started (true) or ended (false): playback pauses through it. */
  onDragChange(dragging: boolean): void;
}

function pct(f: number): string {
  return `${f * 100}%`;
}

/**
 * The seek bar: a 4px track (6px under the pointer) holding what is buffered,
 * where the pointer is, and what has played; a white thumb that scales in on
 * hover; the time under the pointer in a bubble above it. A primary-button
 * press seeks at once and drags with the pointer captured; the player pauses
 * through the drag and resumes after (`onDragChange`). The drag ends however
 * the capture ends — release, cancel, or the capture lost to the browser.
 *
 * Focused, it is a slider with a slider's keys (`seekKeyTarget`), taking them
 * from the player's own (↑ ↓ are not the volume here).
 */
export function SeekBar({
  currentTime,
  duration,
  buffered,
  onSeek,
  onDragChange,
}: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // The drag's truth for the handlers: a release fires pointerup then
  // lostpointercapture in one task, before `dragging` re-renders.
  const draggingNow = useRef(false);
  const [hover, setHover] = useState<{ fraction: number; left: number }>({
    fraction: 0,
    left: 0,
  });

  const d = Number.isFinite(duration) ? duration : 0;
  const played = d > 0 ? currentTime / d : 0;

  const fractionOf = (x: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    return r ? fractionAt(x, r.left, r.width) : 0;
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const f = fractionOf(e.clientX);
    const w = e.currentTarget.getBoundingClientRect().width;
    const bw = bubbleRef.current?.offsetWidth ?? 0;
    setHover({ fraction: f, left: clamp(f * w, bw / 2, w - bw / 2) });
    if (draggingNow.current) onSeek(f * d);
  };

  const endDrag = () => {
    if (!draggingNow.current) return;
    draggingNow.current = false;
    setDragging(false);
    onDragChange(false);
  };

  return (
    <div
      className="mp-seek"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(d)}
      aria-valuenow={Math.round(currentTime)}
      aria-valuetext={`${formatTime(currentTime)} of ${formatTime(d)}`}
      data-dragging={dragging || undefined}
      onPointerMove={onPointerMove}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        draggingNow.current = true;
        setDragging(true);
        onDragChange(true);
        onSeek(fractionOf(e.clientX) * d);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={(e) => {
        const next = seekKeyTarget(e.key, currentTime, d);
        if (next === null) return;
        // The seek bar's own keys: the player's (↑ ↓ volume) must not also fire.
        e.preventDefault();
        e.stopPropagation();
        onSeek(next);
      }}
    >
      <div ref={trackRef} className="mp-track">
        <div
          className="mp-buffered"
          style={{ width: pct(d > 0 ? clamp(buffered / d, 0, 1) : 0) }}
        />
        <div className="mp-hovered" style={{ width: pct(hover.fraction) }} />
        <div className="mp-played" style={{ width: pct(played) }} />
        <div className="mp-thumb" style={{ left: pct(played) }} />
      </div>
      <div ref={bubbleRef} className="mp-bubble" style={{ left: hover.left }}>
        <Text variant="caption" className="tabular-nums">
          {formatTime(hover.fraction * d)}
        </Text>
      </div>
    </div>
  );
}
