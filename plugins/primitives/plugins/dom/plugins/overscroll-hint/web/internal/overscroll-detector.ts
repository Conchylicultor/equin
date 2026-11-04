/**
 * The overscroll hint's driver: finds the scroll gestures that scrolled
 * nothing, and runs the rubber-band they stretch.
 *
 * One frame loop does everything, in order: it takes the frame's batch of
 * gestures (every delta since the last frame, summed — never just the latest),
 * decides whether the batch was wasted, advances the band's physics by the
 * frame's real time and the wasted delta, and draws. The physics
 * (`rubber-band.ts`) turns bursty input into a smooth out-and-back; the DOM
 * half (`bounce-surface.ts`) moves the content without breaking what a real
 * scroll keeps right.
 *
 * A batch is WASTED when no scroller on its gesture's chain scrolled during the
 * frame AND none of them has room left in the gesture's direction. The first
 * test alone is racy (under a fast flick a scroll event can land a frame late,
 * and the page would jump mid-scroll); a scroll event from a scroller off the
 * chain (a streaming log in another pane) says nothing about this gesture and
 * is ignored. The style and geometry reads happen once per frame, never on the
 * wheel path.
 */
import {
  lockSurface,
  scrollRange,
  scrollsOn,
  type Axis,
  type BounceSurface,
} from "./bounce-surface";
import { createRubberBand, type RubberBand } from "./rubber-band";

/** Minimum dominant-axis delta (px) for a frame's batch to count. */
const MIN_DELTA = 2;
/** The dt assumed for a loop's first frame, which has no previous one to measure from. */
const FIRST_FRAME_MS = 1000 / 60;

/** Every gesture since the last frame. */
interface Batch {
  deltaX: number;
  deltaY: number;
  /** The latest gesture's target — the chain the batch is judged on. */
  target: Element;
  /** A scroller on the target's chain scrolled during the frame. */
  scrolled: boolean;
}

/** The bounce in progress: the surface it moves and the band it draws. */
interface Bounce {
  surface: BounceSurface;
  band: RubberBand;
}

/**
 * Install the global wasted-scroll detector. Returns a cleanup function that
 * removes every listener, cancels the frame loop, and puts back any surface
 * left mid-bounce.
 */
export function installOverscrollHint(): () => void {
  let batch: Batch | null = null;
  let bounce: Bounce | null = null;
  let frameId: number | null = null;
  let lastTs: number | null = null;
  let touching = false; // finger down → the band holds where the finger put it
  let touchX = 0;
  let touchY = 0;

  function schedule(): void {
    frameId ??= requestAnimationFrame(frame);
  }

  function frame(ts: number): void {
    frameId = null;
    const dt = lastTs === null ? FIRST_FRAME_MS : ts - lastTs;
    lastTs = ts;

    const taken = batch;
    batch = null;
    const delta = taken ? wastedDelta(taken) : 0;

    if (!bounce) {
      lastTs = null;
      return;
    }
    bounce.band.frame(dt, delta, touching);
    bounce.surface.draw(bounce.band.offset);
    if (bounce.band.atRest && !touching) {
      endBounce();
      return;
    }
    schedule();
  }

  /**
   * The part of a frame's batch that was wasted, along the bounce's axis — 0
   * when nothing was. Locks the bounce onto its surface on the first one.
   */
  function wastedDelta(b: Batch): number {
    if (b.scrolled) return 0;
    const axis: Axis = Math.abs(b.deltaX) > Math.abs(b.deltaY) ? "x" : "y";
    const delta = axis === "x" ? b.deltaX : b.deltaY;
    if (Math.abs(delta) < MIN_DELTA) return 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
    if (hasRoomToScroll(b.target, axis, delta)) return 0;

    const el = pickSurface(b.target, axis);
    if (!(el instanceof HTMLElement)) return 0;
    if (bounce && (bounce.surface.el !== el || bounce.surface.axis !== axis)) {
      endBounce();
    }
    if (!bounce) {
      const surface = lockSurface(el, axis, delta);
      if (!surface) return 0;
      bounce = { surface, band: createRubberBand() };
    }
    return delta;
  }

  function endBounce(): void {
    bounce?.surface.release();
    bounce = null;
    lastTs = null;
  }

  function record(
    deltaX: number,
    deltaY: number,
    target: EventTarget | null,
  ): void {
    if (!(target instanceof Element)) return;
    batch = {
      deltaX: (batch?.deltaX ?? 0) + deltaX,
      deltaY: (batch?.deltaY ?? 0) + deltaY,
      target,
      scrolled: batch?.scrolled ?? false,
    };
    schedule();
  }

  // Listening on the window, in the bubble phase, runs after every listener
  // on the way up — so `defaultPrevented` is final: a gesture consumed on
  // purpose (graph zoom, canvas pan) is not a wasted one.
  function onWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.defaultPrevented) return; // ctrlKey: pinch-zoom
    record(event.deltaX, event.deltaY, event.target);
  }

  function onScroll(event: Event): void {
    if (!batch) return;
    const scroller = event.target;
    if (
      scroller === document ||
      (scroller instanceof Node && scroller.contains(batch.target))
    ) {
      batch.scrolled = true;
    }
  }

  function onTouchStart(event: TouchEvent): void {
    const t = event.touches[0];
    if (!t) return;
    touching = true;
    touchX = t.clientX;
    touchY = t.clientY;
  }

  function onTouchMove(event: TouchEvent): void {
    const t = event.touches[0];
    if (!t || event.defaultPrevented) return;
    // Finger up = content scrolls down: invert to match the wheel's sign.
    const deltaX = touchX - t.clientX;
    const deltaY = touchY - t.clientY;
    touchX = t.clientX;
    touchY = t.clientY;
    record(deltaX, deltaY, event.target);
  }

  function onTouchEnd(event: TouchEvent): void {
    if (event.touches.length > 0) return;
    touching = false; // released → the band springs back from where it was held
    if (bounce) schedule();
  }

  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("touchcancel", onTouchEnd);
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    batch = null;
    endBounce();
  };
}

/**
 * Whether any scroller the gesture could chain through — `start` and its
 * ancestors — can still move in the gesture's direction on `axis`.
 */
function hasRoomToScroll(start: Element, axis: Axis, delta: number): boolean {
  for (let node: Element | null = start; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || !scrollsOn(node, axis)) continue;
    const range = scrollRange(node, axis);
    if (range <= 0) continue;
    const at = Math.abs(axis === "y" ? node.scrollTop : node.scrollLeft);
    if (delta > 0 ? at < range - 1 : at > 1) return true;
  }
  return false;
}

/**
 * The surface a wasted gesture bounces: the nearest scroller on its chain that
 * really scrolls on the axis (one at its edge — the one the gesture ran out
 * of), else the nearest that could (its content fits), else the pane / main /
 * scrolling root around it.
 *
 * Range first, because overflow alone over-matches: a code block that scrolls
 * sideways computes `overflow-y: auto` too, and bouncing it would move only
 * the code inside its box while the page it sits in stays still.
 */
function pickSurface(start: Element, axis: Axis): Element {
  let fallback: Element | null = null;
  for (let node: Element | null = start; node; node = node.parentElement) {
    if (!scrollsOn(node, axis)) continue;
    if (node instanceof HTMLElement && scrollRange(node, axis) > 0) return node;
    fallback ??= node;
  }
  return (
    fallback ??
    start.closest("[data-pane-id]") ??
    document.querySelector("main") ??
    document.scrollingElement ??
    document.documentElement
  );
}
