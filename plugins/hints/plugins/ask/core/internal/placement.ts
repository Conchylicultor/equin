import { z } from "zod";

/**
 * Where the card sits: anchored to its NEAREST horizontal and vertical edges
 * of the viewport, each with its distance from that edge — so a card in the
 * bottom-right corner grows up and to the left as its thread gets longer,
 * and stays in the corner when the window is resized.
 */
export const AskPositionSchema = z.object({
  h: z.enum(["left", "right"]),
  hx: z.number().finite().nonnegative(),
  v: z.enum(["top", "bottom"]),
  vy: z.number().finite().nonnegative(),
});
export type AskPosition = z.infer<typeof AskPositionSchema>;

/** The card's distance from the viewport edges at a corner. */
export const CORNER_MARGIN = 16;
/**
 * The top-right corner's distance from the top: it sits below the action bar
 * (the 36px bar, plus the margin and a hair of air).
 */
export const TOP_RIGHT_CORNER_Y = 58;
/** A drop this close (px) to a corner snaps into it; anywhere else it stays put. */
export const SNAP_DISTANCE = 36;
/** No drop leaves the card closer than this to an edge. */
const EDGE_MIN = 8;

/** Where the card opens the first time: the bottom-right corner. */
export const DEFAULT_ASK_POSITION: AskPosition = {
  h: "right",
  hx: CORNER_MARGIN,
  v: "bottom",
  vy: CORNER_MARGIN,
};

export interface DroppedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a card dropped at `rect` (viewport px) settles in a `viewport` of the
 * given size: kept inside the viewport, anchored to the edges nearest its
 * centre, and — only when it was dropped within {@link SNAP_DISTANCE} of a
 * corner — snapped into that corner. Free everywhere else.
 */
export function placeAfterDrag(
  rect: DroppedRect,
  viewport: { width: number; height: number },
): AskPosition {
  const maxLeft = Math.max(EDGE_MIN, viewport.width - rect.width - EDGE_MIN);
  const maxTop = Math.max(EDGE_MIN, viewport.height - rect.height - EDGE_MIN);
  const left = Math.min(Math.max(rect.left, EDGE_MIN), maxLeft);
  const top = Math.min(Math.max(rect.top, EDGE_MIN), maxTop);

  const h = left + rect.width / 2 < viewport.width / 2 ? "left" : "right";
  const v = top + rect.height / 2 < viewport.height / 2 ? "top" : "bottom";
  const fromH = h === "left" ? left : viewport.width - left - rect.width;
  const fromV = v === "top" ? top : viewport.height - top - rect.height;

  const cornerY =
    v === "top" && h === "right" ? TOP_RIGHT_CORNER_Y : CORNER_MARGIN;
  const snaps =
    Math.abs(fromH - CORNER_MARGIN) < SNAP_DISTANCE &&
    Math.abs(fromV - cornerY) < SNAP_DISTANCE;
  return snaps
    ? { h, hx: CORNER_MARGIN, v, vy: cornerY }
    : { h, hx: Math.max(0, fromH), v, vy: Math.max(0, fromV) };
}
