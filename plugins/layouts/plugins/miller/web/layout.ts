/**
 * Miller's row layout as pure data: every column's box width, which columns
 * are collapsed bars, where the row scrolls to, and what a zoom is. The
 * components only draw what this decides (prototype `proto-1794189254-saewzy`,
 * `open=balanced` + `dblclick=zoom`).
 */

import type { CubicBezier } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";

/** The narrowest a dragged column gets. */
export const MIN_COLUMN_WIDTH = 200;
/** A collapsed column: a vertical bar with the pane title. */
export const BAR_WIDTH = 32;
/** The divider strip on a column's right edge — part of the column's width. */
export const HANDLE_WIDTH = 4;

/**
 * The narrowest the balance shares a column down to: the row shows as many of
 * the newest columns as fit at this width. 420px keeps a conversation's
 * messages readable; a 1470px laptop row shows three columns, a 1920px one four.
 */
export const SHARE_MIN = 420;
/**
 * On a row too narrow for two columns at {@link SHARE_MIN}, the column a pane
 * was opened from stays beside it down to this width each — so an open never
 * swaps the whole row for the new column while 600px are there.
 */
export const PAIR_MIN = 300;

/** One motion for every width change and the scroll that goes with it. */
export const MOTION_MS = 280;
export const MOTION_EASING: CubicBezier = [0.33, 1, 0.68, 1];
export const MOTION_EASING_CSS = `cubic-bezier(${MOTION_EASING.join(", ")})`;
/** A bar appearing in a column that collapses. */
export const BAR_FADE_MS = 160;
/** A pane coming back from a bar. */
export const UNFOLD_FADE_MS = 200;

export interface ColumnInput {
  /** The pane slot's uuid. */
  id: string;
  /**
   * The width the user dragged this pane's column to, kept as is; null for a
   * column that takes its share of the row.
   */
  dragged: number | null;
  /** Collapsed by the user (the divider chevron). Ignored on the leaf. */
  collapsed: boolean;
}

export interface ColumnBox {
  id: string;
  /** The column box's width, its divider included. */
  width: number;
  /** Drawn as a collapsed bar. */
  bar: boolean;
  /** Carries a divider (drag to resize, chevron to collapse). */
  handle: boolean;
  /**
   * The pane's own width inside the box: the box less its divider. For a bar
   * of a zoom, the width its pane keeps under the bar (the unzoomed one), so
   * leaving the zoom finds it laid out already.
   */
  inner: number;
}

export interface RowLayout {
  columns: ColumnBox[];
  /** Sum of the column widths — the row's scroll width. */
  total: number;
  /** The zoomed column's id, when a zoom is in effect. */
  zoomed: string | null;
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * The widths of the row's columns, unzoomed ("balanced") — `dragged[i]` a
 * column's dragged width or null, bars already taken out (`space` is the row
 * less them):
 *
 * - `k`, how many trailing columns (the leaf and its left neighbours) are
 *   shown, depends on the row width alone: as many as fit at
 *   {@link SHARE_MIN} each; fewer than two but two at {@link PAIR_MIN} do:
 *   2. A drag never changes it — two drags that together overshoot the row
 *   must not push the column a pane was opened from off screen.
 * - Those `k` share the row equally (50/50, 33/33/33). A dragged one keeps
 *   its width, the rest sharing what it leaves — scaled down, all dragged
 *   ones in proportion, when the rest would get less than the minimum. The
 *   leaf gets no bonus, so nothing snaps back when the next column opens.
 *   All of them dragged: the leaf shares instead.
 * - The columns left of them keep that same share (or their dragged width)
 *   and sit scrolled off to the left: the row's end puts the window's left
 *   edge on the viewport's — no column half-cut.
 *
 * A row with no width (`space ≤ 0`: laid out under a hidden tab) lays every
 * column at {@link SHARE_MIN}. An unmeasured row is never laid out at all —
 * MillerColumns draws no column before the row's first measure.
 */
function balancedWidths(
  dragged: readonly (number | null)[],
  space: number,
): number[] {
  const n = dragged.length;
  if (n === 0) return [];
  if (space <= 0) return dragged.map((d) => d ?? SHARE_MIN);
  let k = Math.max(1, Math.min(n, Math.floor(space / SHARE_MIN)));
  if (k === 1 && n >= 2 && 2 * PAIR_MIN <= space) k = 2;
  const floor = k * SHARE_MIN <= space ? SHARE_MIN : PAIR_MIN;
  const start = n - k;
  const sharing = new Set<number>();
  for (let i = start; i < n; i++) if (dragged[i] === null) sharing.add(i);
  if (sharing.size === 0) sharing.add(n - 1);
  let kept = 0;
  for (let i = start; i < n; i++) if (!sharing.has(i)) kept += dragged[i]!;
  const room = space - sharing.size * floor;
  const scale = kept > room ? Math.max(0, room) / kept : 1;
  const share = Math.max(
    MIN_COLUMN_WIDTH,
    (space - kept * scale) / sharing.size,
  );
  return dragged.map((d, i) => {
    if (sharing.has(i)) return share;
    if (i >= start) return d! * scale;
    return d ?? share;
  });
}

/**
 * Lay the row out. Unzoomed: {@link balancedWidths} over the columns that
 * are not bars, a user-collapsed non-leaf column a 32px bar.
 *
 * Zoomed (`zoomId` names a column in the row): every other column is a bar,
 * the leaf included, and the zoomed one fills what they leave. A `zoomId` not
 * in the row is no zoom.
 */
export function layoutColumns(
  input: readonly ColumnInput[],
  rowWidth: number,
  zoomId: string | null,
): RowLayout {
  const n = input.length;
  const zoomed =
    zoomId !== null && input.some((c) => c.id === zoomId) ? zoomId : null;
  if (zoomed === null) {
    const bars = input.map((c, i) => i < n - 1 && c.collapsed);
    const open = input.filter((_, i) => !bars[i]);
    const space = rowWidth <= 0 ? 0 : rowWidth - BAR_WIDTH * (n - open.length);
    const shared = balancedWidths(
      open.map((c) => c.dragged),
      space,
    );
    let o = 0;
    const columns = input.map((c, i) => {
      const bar = bars[i]!;
      const handle = !bar && i < n - 1;
      const width = bar ? BAR_WIDTH : shared[o++]!;
      return {
        id: c.id,
        width,
        bar,
        handle,
        inner: bar ? 0 : width - (handle ? HANDLE_WIDTH : 0),
      };
    });
    return { columns, total: sum(columns.map((c) => c.width)), zoomed };
  }
  // Under its bar, a column keeps the pane width it has unzoomed.
  const resting = layoutColumns(input, rowWidth, null).columns;
  const others = (n - 1) * BAR_WIDTH;
  const columns = input.map((c, i) => {
    if (c.id !== zoomed) {
      return {
        id: c.id,
        width: BAR_WIDTH,
        bar: true,
        handle: false,
        inner: resting[i]!.bar
          ? Math.max(0, (c.dragged ?? SHARE_MIN) - HANDLE_WIDTH)
          : resting[i]!.inner,
      };
    }
    const width = Math.max(MIN_COLUMN_WIDTH, rowWidth - others);
    return { id: c.id, width, bar: false, handle: false, inner: width };
  });
  return { columns, total: sum(columns.map((c) => c.width)), zoomed };
}

/**
 * The row while a divider is dragged: what was on screen when the drag began
 * (`start`), the dragged column at `width` (at least {@link MIN_COLUMN_WIDTH})
 * and the leaf growing back to fill the row if it would leave a gap. Nothing
 * else moves, so the divider stays under the pointer — re-balancing would
 * move the columns left of it and pull it away. The balance applies again
 * when the drag ends.
 */
export function dragLayout(
  start: RowLayout,
  id: string,
  width: number,
  rowWidth: number,
): RowLayout {
  const n = start.columns.length;
  const columns = start.columns.map((c) => {
    if (c.id !== id) return { ...c };
    const w = Math.max(MIN_COLUMN_WIDTH, width);
    return { ...c, width: w, inner: w - (c.handle ? HANDLE_WIDTH : 0) };
  });
  const leaf = columns[n - 1];
  if (leaf && leaf.id !== id && !leaf.bar) {
    const others = sum(columns.slice(0, -1).map((c) => c.width));
    const startLeaf = start.columns[n - 1]!.width;
    leaf.width = Math.max(startLeaf, rowWidth - others);
    leaf.inner = leaf.width;
  }
  return { columns, total: sum(columns.map((c) => c.width)), zoomed: null };
}

/**
 * The row's scroll offset after a change: as far right as its end — the
 * newest column fully on screen. Zoomed: the start (the zoomed column fills the
 * row). Leaving a zoom with the route unchanged: back where the row was before
 * the zoom (`restore`), as far as the row still reaches.
 */
export function scrollTarget(
  layout: RowLayout,
  rowWidth: number,
  restore?: number,
): number {
  if (layout.zoomed !== null) return 0;
  const end = Math.max(0, layout.total - rowWidth);
  return restore === undefined ? end : Math.min(end, Math.max(0, restore));
}

/** What identifies a route for zoom: its pane instances, in order. */
export function routeKey(ids: readonly string[]): string {
  return ids.join("|");
}

/**
 * A zoom, made on one route. It holds only while that route is on screen:
 * any route change (an open, a close, a reorder, back/forward) ends it, and
 * there is no state to clear for that to be true.
 */
export interface ZoomState {
  id: string;
  route: string;
  /** The row's scroll offset when the zoom began, restored when it ends. */
  scrollFrom: number;
}

/** The column zoomed on `route` (whose instances are `ids`), or null. */
export function effectiveZoom(
  state: ZoomState | null,
  route: string,
  ids: readonly string[],
): string | null {
  if (!state || state.route !== route || !ids.includes(state.id)) return null;
  return state.id;
}

/**
 * Double-click on column `id`'s header: zoom it; on the zoomed column, leave
 * the zoom; on another while zoomed, move the zoom (its `scrollFrom` kept —
 * leaving restores the row from before the first zoom).
 */
export function toggleZoom(
  state: ZoomState | null,
  id: string,
  route: string,
  ids: readonly string[],
  scrollLeft: number,
): ZoomState | null {
  const current = effectiveZoom(state, route, ids);
  if (current === id) return null;
  if (current !== null && state) return { ...state, id };
  return { id, route, scrollFrom: scrollLeft };
}

/** A click on a bar while zoomed: the zoom moves to that column. */
export function moveZoom(
  state: ZoomState | null,
  id: string,
  route: string,
  ids: readonly string[],
): ZoomState | null {
  if (effectiveZoom(state, route, ids) === null || !state) return state;
  return { ...state, id };
}
