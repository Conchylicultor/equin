import { useState, type AnimationEvent, type ReactNode } from "react";
import { FOLLOW_MOTION_ATTR } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import "./row-enter.css";

/**
 * One transcript row's slot. `arrived`: the row is new since the reader opened
 * the transcript — it eases in once, as it mounts; every other row (the initial
 * load, older pages, a fold opened later) is drawn at rest.
 *
 * The wrapper is always rendered, so the entry ending never changes the tree
 * (which would remount the row). Reduced motion draws every row at rest.
 * Decided at mount only: a row does not start
 * animating because a later render says it arrived.
 */
export function RowEnter({
  arrived,
  children,
}: {
  arrived: boolean;
  children: ReactNode;
}) {
  const [entering, setEntering] = useState(
    () => arrived && !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const onAnimationEnd = (e: AnimationEvent) => {
    // The open animation is the wrapper's own; its child's fade ends with it.
    if (e.target === e.currentTarget) setEntering(false);
  };
  return (
    <div
      className={entering ? "transcript-row-enter" : undefined}
      {...(entering ? { [FOLLOW_MOTION_ATTR]: "" } : {})}
      onAnimationEnd={entering ? onAnimationEnd : undefined}
    >
      {children}
    </div>
  );
}
