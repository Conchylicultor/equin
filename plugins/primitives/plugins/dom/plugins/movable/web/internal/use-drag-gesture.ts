import type { PointerEvent as ReactPointerEvent } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";

/** A pointer position, in viewport px. */
export interface DragPoint {
  x: number;
  y: number;
}

export interface DragGestureHandlers {
  /**
   * The press became a drag: the pointer travelled past the threshold. `from`
   * is where it was pressed, `at` where it is now.
   */
  onStart?: (from: DragPoint, at: DragPoint) => void;
  /** Every move of a live drag; `dx` / `dy` are measured from the press. */
  onMove: (move: DragPoint & { dx: number; dy: number }) => void;
  /** The live drag ended (released or cancelled) at `at`. */
  onEnd?: (at: DragPoint) => void;
}

/** How far the pointer travels before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Presses that belong to the control under them, never to the drag. */
export const NOT_A_HANDLE =
  "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='slider']";
/** Presses on these become a drag only past the threshold (a plain press clicks). */
const CONTROL = "button, a, [role='button']";

/**
 * The drag-to-move gesture, as the `onPointerDown` of the element that is the
 * handle. Grab it anywhere: on its bare surface the drag starts at once; on a
 * button (or link) it starts once the pointer travels {@link DRAG_THRESHOLD_PX},
 * so a plain press is still a click — and the release that ends a drag is
 * swallowed, so it never also presses the button it started on. Text fields
 * and sliders keep their own presses.
 *
 * The pointer is captured when the drag starts, not at the press: captured
 * from the press, the release would land on the handle and the button's click
 * would never fire; captured once moving, the drag keeps following over an
 * iframe.
 *
 * Only a press inside the handle's DOM box counts: React bubbles a press in a
 * portaled popup (a popover opened from a button in the handle) through the
 * handle's tree, but that press is the popup's, never a drag.
 */
export function useDragGesture(
  handlers: DragGestureHandlers,
): (e: ReactPointerEvent<HTMLElement>) => void {
  const latest = useLatestRef(handlers);

  return (e) => {
    const handle = e.currentTarget;
    if (e.button !== 0) return;
    if (!(e.target instanceof Element) || !handle.contains(e.target)) return;
    if (e.target.closest(NOT_A_HANDLE)) return;
    const onControl = e.target.closest(CONTROL) !== null;
    // On the bare surface, keep the press from selecting text as it moves.
    if (!onControl) e.preventDefault();
    const pointerId = e.pointerId;
    const from = { x: e.clientX, y: e.clientY };
    let live = false;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const at = { x: ev.clientX, y: ev.clientY };
      const dx = at.x - from.x;
      const dy = at.y - from.y;
      if (!live) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        live = true;
        handle.setPointerCapture(pointerId);
        latest.current.onStart?.(from, at);
      }
      latest.current.onMove({ ...at, dx, dy });
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!live) return;
      latest.current.onEnd?.({ x: ev.clientX, y: ev.clientY });
      // The click this release dispatches belongs to the drag, not to the
      // button it started on. It is dispatched in the same task, so the
      // swallow is gone before any later click.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true });
      setTimeout(
        () => window.removeEventListener("click", swallow, { capture: true }),
        0,
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
}
