import { useState, type AnimationEvent, type ReactNode } from "react";
import { FOLLOW_MOTION_ATTR } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { prefersReducedMotion } from "./reduced-motion";
import "./arrival.css";

export interface ArrivalProps {
  /**
   * The row is new since the reader started watching — a transcript line
   * written while they read, a block another writer added to the open page.
   * Read at MOUNT only: a row does not start easing in because a later render
   * says it arrived, and the initial load (every row with `arrived: false`)
   * is drawn at rest.
   */
  arrived: boolean;
  children: ReactNode;
}

/**
 * One row's slot in a flow of rows. An `arrived` row eases in once, as it
 * mounts: its slot opens from zero height (so the rows after it glide instead
 * of jumping by its height) while it fades in. Every other row is drawn at rest.
 *
 * The wrapper is always rendered, so the entry ending never changes the tree
 * (which would remount the row). Reduced motion draws every row at rest. While
 * entering, the wrapper carries `FOLLOW_MOTION_ATTR`, so a stick-to-bottom
 * surface glides with the opening instead of catching up in steps.
 */
export function Arrival({ arrived, children }: ArrivalProps) {
  const [entering, setEntering] = useState(
    () => arrived && !prefersReducedMotion(),
  );
  const onAnimationEnd = (e: AnimationEvent) => {
    // The open animation is the wrapper's own; its child's fade ends with it.
    if (e.target === e.currentTarget) setEntering(false);
  };
  return (
    <div
      className={entering ? "arrival-enter" : undefined}
      {...(entering ? { [FOLLOW_MOTION_ATTR]: "" } : {})}
      onAnimationEnd={entering ? onAnimationEnd : undefined}
    >
      {children}
    </div>
  );
}
