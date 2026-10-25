import { useLayoutEffect, useRef, type RefObject } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { prefersReducedMotion } from "./reduced-motion";

/** How long a surface takes to reach its new size, and along what curve —
 *  the glide the hints stage and the sonata dock already move on. */
export const SIZE_MS = 240;
export const SIZE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** A size change counts as the content's doing when a mutation inside the
 *  surface landed this recently before it (a commit and its layout are one
 *  frame apart; a window resize carries no mutation at all). */
const CONTENT_WINDOW_MS = 120;

interface Box {
  w: number;
  h: number;
  /** The corner radius as drawn — capped at half the shorter side, so a
   *  pill's `9999px` reads as the half-height it paints. */
  r: number;
}

function measure(el: HTMLElement): Box {
  // offset* = the border box, immune to a running `scale` (an enter).
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const r = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  return { w, h, r: Math.min(r, w / 2, h / 2) };
}

const LAYOUT_PROPERTY =
  /^(width|height|min-?width|min-?height|max-?width|max-?height|margin.*|padding.*|flex.*|grid.*|inset|top|bottom|left|right)$/i;

/** Whether an animation inside the surface is moving its layout — a fold
 *  (`FoldMotion` tweens `max-height`), a row glide. Opacity, scale and
 *  colour don't change the surface's size. */
function animatesLayout(a: Animation): boolean {
  if (typeof CSSTransition !== "undefined" && a instanceof CSSTransition) {
    return LAYOUT_PROPERTY.test(a.transitionProperty);
  }
  const effect = a.effect;
  if (typeof KeyframeEffect === "undefined") return false;
  if (!(effect instanceof KeyframeEffect)) return false;
  return effect
    .getKeyframes()
    .some((frame) =>
      Object.keys(frame).some(
        (k) =>
          k !== "offset" &&
          k !== "computedOffset" &&
          k !== "easing" &&
          k !== "composite" &&
          LAYOUT_PROPERTY.test(k),
      ),
    );
}

interface Watch {
  el: HTMLElement | null;
  /** The last resting box, the next tween's start. */
  rest: Box | null;
  /** When the content last changed (a mutation inside the surface). */
  changedAt: number;
  running: Animation | null;
  mutations: MutationObserver | null;
}

function sameBox(a: Box, b: Box): boolean {
  return a.w === b.w && a.h === b.h && a.r === b.r;
}

function othersMoveLayout(w: Watch, el: HTMLElement): boolean {
  return el
    .getAnimations({ subtree: true })
    .some(
      (a) => a !== w.running && a.playState === "running" && animatesLayout(a),
    );
}

function tween(w: Watch, el: HTMLElement, from: Box, to: Box): void {
  const start: Keyframe = {};
  const end: Keyframe = {};
  if (from.w !== to.w) {
    Object.assign(start, {
      width: `${from.w}px`,
      minWidth: "0px",
      maxWidth: "none",
    });
    Object.assign(end, {
      width: `${to.w}px`,
      minWidth: "0px",
      maxWidth: "none",
    });
  }
  if (from.h !== to.h) {
    Object.assign(start, {
      height: `${from.h}px`,
      minHeight: "0px",
      maxHeight: "none",
    });
    Object.assign(end, {
      height: `${to.h}px`,
      minHeight: "0px",
      maxHeight: "none",
    });
  }
  if (from.r !== to.r) {
    start.borderRadius = `${from.r}px`;
    end.borderRadius = `${to.r}px`;
  }
  // A box that shows its overflow would spill the content laid out at the
  // new size past the old one; one that already clips or scrolls keeps its
  // own overflow (and its scroll position).
  if (getComputedStyle(el).overflow === "visible") {
    start.overflow = "clip";
    end.overflow = "clip";
  }
  const anim = el.animate([start, end], {
    duration: SIZE_MS,
    easing: SIZE_EASING,
  });
  w.running = anim;
  anim.onfinish = () => {
    w.running = null;
    // A content change that landed mid-tween is caught up in a second one.
    const now = measure(el);
    const target = w.rest ?? now;
    w.rest = now;
    if (
      !sameBox(target, now) &&
      performance.now() - w.changedAt < SIZE_MS + CONTENT_WINDOW_MS
    ) {
      tween(w, el, target, now);
    }
  };
}

/** A size report: tween it when the content caused it. */
function onResize(w: Watch): void {
  const el = w.el;
  if (el === null || w.running) return;
  const to = measure(el);
  const from = w.rest;
  w.rest = to;
  if (from === null || sameBox(from, to)) return;
  if (performance.now() - w.changedAt > CONTENT_WINDOW_MS) return;
  if (from.w === 0 || from.h === 0 || to.w === 0 || to.h === 0) return;
  if (prefersReducedMotion() || othersMoveLayout(w, el)) return;
  tween(w, el, from, to);
}

/**
 * Tweens the size of the element `target` holds whenever its CONTENT changes
 * it — a card turning into a pill, a list drilling into a detail, a thread
 * growing — instead of letting it jump. `enabled` false watches nothing.
 *
 * - A `MutationObserver` stamps when the content last changed; the size
 *   report (`useResizeObserver`, undebounced: delivered after layout, before
 *   paint — so the first frame drawn is already the old size) tweens only a
 *   change that follows one. A window resize or a parent's re-layout lands
 *   at once.
 * - The tween runs on the element itself: width / height / corner radius
 *   from the last resting box to the new one, the content clipped meanwhile.
 *   Only the dimensions that changed move, so a width the layout owns stays
 *   responsive.
 * - While it runs, size reports are its own and ignored; when it lands, a
 *   content change that arrived meanwhile is caught up in a second tween.
 * - Something inside already moving the layout (a fold) means the surface
 *   just follows it frame by frame — two tweens of one size would fight.
 * - Never from or to an empty box, and never under reduced motion.
 */
export function useSizeMotion(
  target: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const watch = useRef<Watch>({
    el: null,
    rest: null,
    changedAt: Number.NEGATIVE_INFINITY,
    running: null,
    mutations: null,
  });
  // After each commit: follow whatever element the ref names now (a remount
  // starts a fresh watch; the same element keeps its own).
  useLayoutEffect(() => {
    const w = watch.current;
    const el = enabled ? target.current : null;
    if (w.el === el) return;
    w.mutations?.disconnect();
    w.running?.cancel();
    w.running = null;
    w.el = el;
    w.rest = el ? measure(el) : null;
    w.mutations = null;
    if (el) {
      const mutations = new MutationObserver(() => {
        w.changedAt = performance.now();
      });
      mutations.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      w.mutations = mutations;
    }
  });
  useLayoutEffect(() => {
    const w = watch.current;
    return () => {
      w.mutations?.disconnect();
      w.running?.cancel();
      w.running = null;
      w.el = null;
    };
  }, []);
  useResizeObserver(
    () => (enabled ? target.current : null),
    () => onResize(watch.current),
    { debounce: false, deps: [enabled] },
  );
}
