/**
 * The runtime half of the touch-claim contract: a drag must declare its touch.
 *
 * A drag control (a dial, a slider, a resize handle, a canvas) takes its
 * pointer with `setPointerCapture`. On a touch screen that is not enough: unless
 * the element's `touch-action` stops the browser panning, the browser takes the
 * gesture itself — `pointercancel` after a few pixels, the page scrolls instead,
 * and the overscroll hint (which leaves a CLAIMED touch alone, see
 * `touch-action.ts`) cannot tell the drag from a wasted scroll.
 *
 * Whether the claim is there is only knowable here, at runtime: the capture call
 * and the `touch-action` routinely sit in different files (a CSS file, a drag
 * hook handed someone else's element), so no lint rule can see both. So the
 * check runs on every capture the page makes — every drag in the app, today's
 * and tomorrow's, with nothing to wire — and fails loudly.
 *
 * A claim on ONE axis is a claim: a sideways dial in a vertical sheet says
 * `pan-y`, and the browser still scrolls the sheet. Only a capture whose
 * touch-action lets the browser pan BOTH ways is a broken drag.
 *
 * The fault never interrupts the drag: it is raised after the capture, as an
 * uncaught error (which is what files the report — one per element, its handle
 * in the message), and the drag runs exactly as it would have.
 */
import { describeElement } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { touchMayPan } from "./touch-action";

/** A touch drag captured an element that never claimed its touch. */
export class UnclaimedTouchDragError extends Error {
  override name = "UnclaimedTouchDragError";
}

/** What a pointer's `pointerdown` said: its type, and where the touch began. */
interface Down {
  touch: boolean;
  target: Element;
}

/**
 * Install the guard; returns the uninstall.
 *
 * It wraps `Element.prototype.setPointerCapture` (the page's own call is the
 * one thing that marks a drag: a touch pointer is ALSO captured implicitly by
 * the browser on every tap, firing the same `gotpointercapture`, so the event
 * cannot tell the two apart). The check reads the chain from where the touch
 * BEGAN — the browser decides whether to pan from that target, not from the
 * element that captures. The fault is raised with `reportError`: the same
 * uncaught-error event, without throwing into the caller's handler.
 */
export function installTouchClaimGuard(): () => void {
  const downs = new Map<number, Down>();
  const onDown = (event: PointerEvent): void => {
    if (event.target instanceof Element)
      downs.set(event.pointerId, {
        touch: event.pointerType === "touch",
        target: event.target,
      });
  };
  const onEnd = (event: PointerEvent): void => {
    downs.delete(event.pointerId);
  };

  const proto = Element.prototype;
  const original = proto.setPointerCapture;
  function guarded(this: Element, pointerId: number): void {
    original.call(this, pointerId);
    const down = downs.get(pointerId);
    if (!down?.touch) return;
    if (!touchMayPan(down.target, "x") || !touchMayPan(down.target, "y"))
      return;
    reportError(
      new UnclaimedTouchDragError(
        `A touch drag captured <${describeElement(this)}>, but its ` +
          `touch-action still lets the browser pan both ways: on a phone the ` +
          `browser takes the gesture (pointercancel) and scrolls or bounces the ` +
          `panel instead. Declare it on the drag element — touch-action: none ` +
          `(Tailwind touch-none), or pan-y / pan-x to leave one axis to scrolling.`,
      ),
    );
  }
  proto.setPointerCapture = guarded;

  window.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointerup", onEnd, { capture: true });
  window.addEventListener("pointercancel", onEnd, { capture: true });
  return () => {
    if (proto.setPointerCapture === guarded) proto.setPointerCapture = original;
    window.removeEventListener("pointerdown", onDown, { capture: true });
    window.removeEventListener("pointerup", onEnd, { capture: true });
    window.removeEventListener("pointercancel", onEnd, { capture: true });
  };
}
