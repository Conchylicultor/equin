/**
 * Whether the browser may pan on an axis for a touch, read from `touch-action`.
 *
 * A touch on an element whose `touch-action` forbids panning on the axis (a
 * dial, a slider, a canvas — `none`, or `pan-y` for a sideways drag) is the
 * page's own gesture: the browser never scrolls for it, and nothing cancels
 * its `touchmove` (pointer events do the work), so to the overscroll hint it
 * would look exactly like a scroll that went nowhere. It is not one — the
 * touch twin of a wheel the page `preventDefault`s.
 */
import type { Axis } from "./bounce-surface";

/** Whether one computed `touch-action` value lets the browser pan on `axis`. */
export function touchActionAllows(value: string, axis: Axis): boolean {
  const tokens = value.trim().split(/\s+/);
  if (tokens.includes("auto") || tokens.includes("manipulation")) return true;
  const pans =
    axis === "x"
      ? ["pan-x", "pan-left", "pan-right"]
      : ["pan-y", "pan-up", "pan-down"];
  return tokens.some((t) => pans.includes(t));
}

/**
 * Whether a touch on `start` may pan on `axis`: every element from it up to
 * the root must allow it (the effective touch-action is their intersection).
 */
export function touchMayPan(start: Element, axis: Axis): boolean {
  for (let node: Element | null = start; node; node = node.parentElement) {
    if (!touchActionAllows(getComputedStyle(node).touchAction, axis))
      return false;
  }
  return true;
}
