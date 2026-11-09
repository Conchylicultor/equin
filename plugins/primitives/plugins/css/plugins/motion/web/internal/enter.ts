import { useLayoutEffect, useState, type RefObject } from "react";
import { overlayTiming } from "./overlay-timing";
import { prefersReducedMotion } from "./reduced-motion";

/**
 * Fades and scales an element in — the overlay token group's enter, read in
 * the scope of `scope` (the element itself by default). The one entrance
 * `Presence`, `useFlowMotion` and `useEnterMotion` play. Nothing where the
 * enter's duration is `0` (or unset — a test document without the theme).
 */
export function playOverlayEnter(
  el: HTMLElement,
  scope: Element = el,
): Animation | null {
  const timing = overlayTiming(scope);
  if (timing.enterMs <= 0) return null;
  // One keyframe, the start: it ends on the element's own resting opacity
  // and scale, whatever they are.
  return el.animate([{ opacity: 0, scale: timing.scale, offset: 0 }], {
    duration: timing.enterMs,
    easing: timing.easing,
  });
}

/**
 * Plays the overlay enter on the element `ref` holds as it mounts, when
 * `arrived()` says so — for an element its container places itself
 * (absolutely: a canvas frame), which `useFlowMotion` cannot see.
 *
 * `arrived` is the caller's judgement, asked once, in the mount's layout
 * effect, like `<Arrival>`'s `arrived` (read at mount only): only the owner
 * can tell an element added while the reader watches from one drawn with the
 * first render. A function, so the owner can answer from what it recorded of
 * its previous commit (a ref) without reading it during render. Never under
 * reduced motion.
 */
export function useEnterMotion(
  ref: RefObject<HTMLElement | null>,
  arrived: () => boolean,
): void {
  const [askAtMount] = useState(() => arrived);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || !askAtMount()) return;
    const anim = playOverlayEnter(el);
    return () => anim?.cancel();
  }, [ref, askAtMount]);
}
