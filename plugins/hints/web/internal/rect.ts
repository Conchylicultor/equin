/** A box in viewport coordinates (a plain copy of a DOMRect's geometry). */
export interface HintRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Room left around an anchor by the spotlight cut-out, the halo and the card. */
export const ANCHOR_PADDING = 6;

export function inflate(rect: HintRect, by: number): HintRect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
  };
}

export function rectOf(el: Element): HintRect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function sameRect(a: HintRect | null, b: HintRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}
