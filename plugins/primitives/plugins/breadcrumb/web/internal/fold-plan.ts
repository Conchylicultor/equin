/**
 * Slack the row must have beyond the exact fit before a folded ancestor comes
 * back. Without a margin, "fold" and "unfold" share their boundary condition
 * and a one-subpixel measurement disagreement flips the trail every frame.
 */
export const EXPAND_MARGIN_PX = 4;

/** A measured difference this small is a rounding artefact, not an overflow. */
export const SUBPIXEL_PX = 1;

/** What one fold decision reads, all in layout pixels. */
export interface FoldInput {
  /** How many leading ancestors are folded behind the overflow crumb now. */
  hidden: number;
  /** How many ancestors the trail has. */
  count: number;
  /** How far the leaf is cut: its `scrollWidth` past its `clientWidth`. */
  deficit: number;
  /** The row's free space past its last child. */
  free: number;
  /**
   * Each ancestor's width in the row when last seen — its crumb, its
   * separator and the gaps after them — by index; `undefined` for one never
   * seen on this trail.
   */
  widths: readonly (number | undefined)[];
  /** The overflow crumb's width the same way, once seen; `undefined` before. */
  foldUnit: number | undefined;
}

/**
 * How many leading ancestors to fold: the fewest that let the leaf stand
 * whole, so the ones nearest the page stay readable as long as there is room.
 *
 * - **Cut leaf** → fold the oldest visible ancestors until what they give back
 *   covers the cut (less the overflow crumb, when it is the first fold).
 * - **Room to spare** → bring folded ancestors back, nearest first, while the
 *   free space covers each one (the last one also returns the overflow crumb's
 *   width), keeping a margin.
 * - **A folded ancestor never seen on this trail** → show them all: the next
 *   pass measures them and folds again what really does not fit.
 */
export function planFold({
  hidden,
  count,
  deficit,
  free,
  widths,
  foldUnit,
}: FoldInput): number {
  if (deficit > SUBPIXEL_PX) {
    let next = hidden;
    let given = hidden === 0 ? -(foldUnit ?? 0) : 0;
    while (next < count && given < deficit) {
      given += widths[next] ?? 0;
      next += 1;
    }
    return next;
  }
  let next = hidden;
  let room = free - EXPAND_MARGIN_PX;
  while (next > 0) {
    const width = widths[next - 1];
    if (width === undefined) return 0;
    const cost = width - (next === 1 ? (foldUnit ?? 0) : 0);
    if (cost > room) break;
    room -= cost;
    next -= 1;
  }
  return next;
}
