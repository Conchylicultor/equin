import { useState, type AnimationEvent, type ReactNode } from "react";
import { prefersReducedMotion } from "./reduced-motion";
import "./reveal.css";

/**
 * Content that APPEARS in a surface that is already drawn — a render-slot item
 * its layout un-hid, a field a view newly shows. Wrap the content when (and
 * only when) it appears later: it eases its slot open, fades in and carries a
 * short accent wash, once. Content present at the surface's first draw is not
 * wrapped, so it never animates.
 *
 * The wrapper is always rendered, so the reveal ending changes no tree (a
 * remount would restart the content). Decided at mount: under reduced motion
 * there is no movement. At rest the wrapper is `display: contents`.
 */
export function Reveal({ children }: { children: ReactNode }) {
  const [revealing, setRevealing] = useState(() => !prefersReducedMotion());
  const onAnimationEnd = (e: AnimationEvent) => {
    // The wash is the longest of the wrapper's own animations.
    if (e.target === e.currentTarget && e.animationName === "reveal-wash") {
      setRevealing(false);
    }
  };
  return (
    <div
      className={revealing ? "reveal-in" : "contents"}
      onAnimationEnd={revealing ? onAnimationEnd : undefined}
    >
      {/* The one grid cell: the slot's own box may be `display: contents`. */}
      <div className={revealing ? "reveal-in-body" : "contents"}>
        {children}
      </div>
    </div>
  );
}

/**
 * Whether `shown` turned on after this component mounted — the cue to wrap
 * what it shows in {@link Reveal}. False when it was already on at the first
 * draw (nothing appears then), and again when it goes off.
 */
export function useRevealedLater(shown: boolean): boolean {
  const [later, setLater] = useState(false);
  const [prev, setPrev] = useState(shown);
  if (shown !== prev) {
    setPrev(shown);
    setLater(shown);
  }
  return later;
}
