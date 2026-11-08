import {
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FOLLOW_MOTION_ATTR } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { prefersReducedMotion } from "./reduced-motion";
import "./arrival.css";

/**
 * One row's place in a BATCH — the rows one write added together (an agent's
 * one edit adding several blocks). The batch arrives as one gesture: every
 * row's slot opens on the same curve at the same moment, so the room for the
 * whole batch opens as one continuous push, and each row's content cascades in
 * at its `step`.
 *
 * - `{ step: n }` — the row's content enters at step `n` (0-based, in document
 *   order). Rows that belong together (a block and the children that enter
 *   with it) share a step.
 * - `{ step: null }` — the row has nothing to show (an empty line): its room
 *   opens with the batch, it has no entry of its own.
 */
export interface ArrivalStep {
  step: number | null;
}

export interface ArrivalProps {
  /**
   * The row is new since the reader started watching — a transcript line
   * written while they read (`true`: one row on its own, a quick ease), a
   * block another writer added to the open page (an `ArrivalStep`: one row of
   * a batch arriving as one gesture). Read at MOUNT only: a row does not start
   * easing in because a later render says it arrived, and the initial load
   * (every row with `arrived: false`) is drawn at rest.
   */
  arrived: boolean | ArrivalStep;
  children: ReactNode;
}

// The staged batch's content cascade (the open itself is all CSS): the first
// step starts a third into the room's opening, each next one 70 ms later. A
// row taller than `LARGE_PX` (a map, an image) rises further and a bit slower.
const FIRST_STEP_MS = 175;
const STEP_GAP_MS = 70;
const LARGE_PX = 160;

/**
 * One row's slot in a flow of rows. An `arrived` row eases in once, as it
 * mounts: its slot opens from zero height (so the rows after it glide instead
 * of jumping by its height) while it enters. Every other row is drawn at rest.
 *
 * The wrapper is always rendered, so the entry ending never changes the tree
 * (which would remount the row). Reduced motion draws every row at rest. While
 * entering, the wrapper carries `FOLLOW_MOTION_ATTR`, so a stick-to-bottom
 * surface glides with the opening instead of catching up in steps. Nothing
 * here scrolls, focuses or measures the scroller: the camera is the viewer's.
 */
export function Arrival({ arrived, children }: ArrivalProps) {
  const [entering] = useState(() =>
    arrived === false || prefersReducedMotion()
      ? null
      : arrived === true
        ? ("row" as const)
        : arrived,
  );
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = entering !== null && !done;
  const staged = entering !== null && entering !== "row";
  const step = staged ? entering.step : null;
  // The entry ends with its last animation: the open, and the content's rise
  // when it has one (a later step outlasts the open).
  const pending = useRef(
    new Set(
      step !== null ? ["arrival-open", "arrival-rise"] : ["arrival-open"],
    ),
  );
  // A large row's entry is slower and rises further. Measured before the
  // first paint (the content's own boxes: the slot itself is clipped to 0).
  useLayoutEffect(() => {
    const slot = ref.current;
    if (step === null || !slot) return;
    const content = slot.firstElementChild;
    // A row with no box of its own to rise has no rise to wait for.
    if (!content || getComputedStyle(content).display === "contents") {
      pending.current.delete("arrival-rise");
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(content);
    if (range.getBoundingClientRect().height > LARGE_PX)
      slot.classList.add("arrival-large");
  }, [step]);
  const onAnimationEnd = (e: AnimationEvent) => {
    const own =
      e.target === e.currentTarget ||
      e.target === e.currentTarget.firstElementChild;
    if (!own) return;
    if (!staged) {
      // The quick ease: the open is the wrapper's own; the fade ends with it.
      if (e.target === e.currentTarget) setDone(true);
      return;
    }
    pending.current.delete(e.animationName);
    if (pending.current.size === 0) setDone(true);
  };
  const className = !active
    ? undefined
    : staged
      ? step === null
        ? "arrival-batch"
        : "arrival-batch arrival-cue"
      : "arrival-enter";
  const style: CSSProperties | undefined =
    active && step !== null
      ? ({
          "--arrival-delay": `${FIRST_STEP_MS + step * STEP_GAP_MS}ms`,
        } as CSSProperties)
      : undefined;
  return (
    <div
      ref={ref}
      className={className}
      style={style}
      {...(active ? { [FOLLOW_MOTION_ATTR]: "" } : {})}
      onAnimationEnd={active ? onAnimationEnd : undefined}
    >
      {children}
    </div>
  );
}
