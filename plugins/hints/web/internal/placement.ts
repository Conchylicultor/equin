import type { HintPlacement } from "../../core";
import type { HintRect } from "./rect";

/** The card's gap to its target, and its margin to the frame's edges, in px. */
export const CARD_GAP = 14;
export const FRAME_MARGIN = 12;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The sides a card tries, preferred first: then its opposite, then the cross axis. */
export function sideOrder(preferred: HintPlacement): readonly HintPlacement[] {
  switch (preferred) {
    case "bottom":
      return ["bottom", "top", "right", "left"];
    case "top":
      return ["top", "bottom", "left", "right"];
    case "right":
      return ["right", "left", "bottom", "top"];
    case "left":
      return ["left", "right", "bottom", "top"];
  }
}

/**
 * Where a card of `card` size goes beside `target` (both in the frame's
 * coordinates): the first side in `order` it fits on whole, else the first
 * side; centered on the target along the other axis (a side card aligns near
 * the top of a tall target, so it reads beside its start rather than its
 * middle), then clamped inside the frame.
 */
export function placeCard(
  target: HintRect,
  card: Size,
  frame: Size,
  order: readonly HintPlacement[],
): Point {
  const fits: Record<HintPlacement, boolean> = {
    bottom:
      target.y + target.height + CARD_GAP + card.height <=
      frame.height - FRAME_MARGIN,
    top: target.y - CARD_GAP - card.height >= FRAME_MARGIN,
    right:
      target.x + target.width + CARD_GAP + card.width <=
      frame.width - FRAME_MARGIN,
    left: target.x - CARD_GAP - card.width >= FRAME_MARGIN,
  };
  const side = order.find((s) => fits[s]) ?? order[0] ?? "bottom";
  let x: number;
  let y: number;
  if (side === "top" || side === "bottom") {
    x = target.x + target.width / 2 - card.width / 2;
    y =
      side === "bottom"
        ? target.y + target.height + CARD_GAP
        : target.y - CARD_GAP - card.height;
  } else {
    x =
      side === "right"
        ? target.x + target.width + CARD_GAP
        : target.x - CARD_GAP - card.width;
    y = target.y + Math.min(target.height, 200) / 2 - 40;
  }
  return {
    x: clamp(x, FRAME_MARGIN, frame.width - card.width - FRAME_MARGIN),
    y: clamp(y, FRAME_MARGIN, frame.height - card.height - FRAME_MARGIN),
  };
}

/** The frame's center for a card of `card` size. */
export function centerCard(card: Size, frame: Size): Point {
  return {
    x: (frame.width - card.width) / 2,
    y: (frame.height - card.height) / 2,
  };
}

/** `v` within [lo, hi]; `lo` wins when the range is empty (a card wider than the frame). */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}
