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
import { arrivalDelayMs } from "./arrival-timing";
import "./arrival.css";

/**
 * One row's place in a BATCH — the rows one write added together (an agent's
 * one edit adding several blocks). The batch arrives as a top-to-bottom
 * cascade: each row's slot opens at its `step`, its content entering with it,
 * the next step 150 ms later — the openings overlap, so the room is one
 * continuous push and what is below the batch moves as one mass.
 *
 * - `step` — when the row arrives (0-based, in document order). Rows that
 *   belong together (a block and the children that enter with it) share a
 *   step, and open together.
 * - `steps` — the batch's number of steps, the same on every row: a long
 *   batch compresses its gaps (`arrival-timing.ts`).
 * - `blank` — the row has nothing to show (an empty line): its room opens at
 *   its step, it has no entry of its own.
 *
 * A row's content is clipped by its own slot while it opens, so its slot and
 * its content arrive TOGETHER: content entering a slot that all the batch's
 * rows open at once would be revealed by every slot at once, whatever its
 * delay.
 */
export interface ArrivalStep {
  step: number;
  steps: number;
  blank: boolean;
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

// A row taller than `LARGE_PX` (a map, an image) rises further and a bit
// slower (the CSS's `.arrival-large`).
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
  // The row's content entry (none for a blank row).
  const cue = staged && !entering.blank;
  // The entry ends with its last animation: the open, and the content's rise
  // when it has one.
  const pending = useRef(
    new Set(cue ? ["arrival-open", "arrival-rise"] : ["arrival-open"]),
  );
  // A large row's entry is slower and rises further. Measured before the
  // first paint (the content's own boxes: the slot itself is clipped to 0).
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!cue || !slot) return;
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
  }, [cue]);
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
      ? cue
        ? "arrival-batch arrival-cue"
        : "arrival-batch"
      : "arrival-enter";
  const style: CSSProperties | undefined =
    active && staged
      ? ({
          "--arrival-delay": `${arrivalDelayMs(entering.step, entering.steps)}ms`,
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
