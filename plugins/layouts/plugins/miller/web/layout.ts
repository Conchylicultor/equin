/**
 * Miller's row layout as pure data: every column's box width, which columns
 * are collapsed bars, where the row scrolls to, and what a zoom is. The
 * components only draw what this decides (prototype `proto-1794189254-saewzy`,
 * `open=scroll` + `dblclick=zoom`).
 */

import type { CubicBezier } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";

/** A pane's column width when it declares none (`Pane.define({ width })`). */
export const DEFAULT_COLUMN_WIDTH = 400;
/** The narrowest a dragged column gets. */
export const MIN_COLUMN_WIDTH = 200;
/** A collapsed column: a vertical bar with the pane title. */
export const BAR_WIDTH = 32;
/** The divider strip on a column's right edge — part of the column's width. */
export const HANDLE_WIDTH = 4;

/**
 * How far the fit may compress a column: to {@link FLOOR_RATIO} of its own
 * width, never below {@link FLOOR_MIN} (and never wider than it is). Two
 * thirds keeps a column recognisably the layout its pane was designed at —
 * text re-wraps, nothing reflows into another arrangement — and is what lets
 * three default panes share a laptop row (a 1136px row holds 320 + 480 + 600
 * at 0.71) instead of the third one scrolling the first away. 240px is the
 * narrowest a list column still shows a title beside its icon and trailing
 * meta (the tasks list, 320 wide, stops at 240).
 */
export const FLOOR_RATIO = 0.65;
export const FLOOR_MIN = 240;

/** The narrowest the fit compresses a column of own width `width`. */
export function columnFloor(width: number): number {
  return Math.min(width, Math.max(FLOOR_MIN, Math.round(FLOOR_RATIO * width)));
}

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
  /** Its own width: the dragged one, else the pane's declared, else 400. */
  width: number;
  /** Collapsed by the user (the divider chevron). Ignored on the leaf. */
  collapsed: boolean;
  /** The user dragged this width: the fit never compresses it. */
  fixed?: boolean;
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
 * The widths of the row's columns, unzoomed ("fit"): every column has its own
 * width `w` and a floor `m` ({@link columnFloor}; a bar is 32 fixed, a dragged
 * column its own width fixed).
 *
 * - The columns fit (`Σw ≤ row`): each at its own width, the leaf growing to
 *   fill the rest.
 * - They don't: the largest trailing window — the leaf and as many columns to
 *   its left as possible — whose floors fit the row is shown, its columns
 *   compressed in proportion from `w` toward `m` so that together they fill
 *   the row exactly (at their own widths, the leaf filling, when they already
 *   fit). The columns left of the window sit at their floor, scrolled off to
 *   the left: the row's end puts the window's left edge on the viewport's.
 * - Not even the leaf's floor fits: the leaf takes it and the row scrolls.
 *
 * An unmeasured row (`rowWidth ≤ 0`) lays every column at its own width.
 */
function fitWidths(
  w: readonly number[],
  m: readonly number[],
  rowWidth: number,
): number[] {
  const n = w.length;
  if (n === 0) return [];
  const out = [...w];
  if (rowWidth <= 0) return out;
  if (sum(w) <= rowWidth) {
    out[n - 1]! += rowWidth - sum(w);
    return out;
  }
  let start = n;
  let floors = 0;
  while (start > 0 && floors + m[start - 1]! <= rowWidth) {
    floors += m[start - 1]!;
    start--;
  }
  for (let i = 0; i < start; i++) out[i] = m[i]!;
  if (start === n) {
    out[n - 1] = Math.max(m[n - 1]!, rowWidth);
    return out;
  }
  const ww = sum(w.slice(start));
  if (ww <= rowWidth) {
    out[n - 1]! += rowWidth - ww;
    return out;
  }
  const t = (ww - rowWidth) / (ww - floors);
  for (let i = start; i < n; i++) out[i] = w[i]! - t * (w[i]! - m[i]!);
  return out;
}

/**
 * Lay the row out. Unzoomed: {@link fitWidths} over the columns' own widths,
 * a user-collapsed non-leaf column a 32px bar.
 *
 * Zoomed (`zoomId` names a column in the row): every other column is a bar,
 * the leaf included, and the zoomed one fills what they leave (never below its
 * own width). A `zoomId` not in the row is no zoom.
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
    const w = input.map((c, i) => (bars[i] ? BAR_WIDTH : c.width));
    const m = input.map((c, i) =>
      bars[i] || c.fixed ? w[i]! : columnFloor(w[i]!),
    );
    const widths = fitWidths(w, m, rowWidth);
    const columns = input.map((c, i) => {
      const bar = bars[i]!;
      const handle = !bar && i < n - 1;
      const width = widths[i]!;
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
          ? Math.max(0, c.width - HANDLE_WIDTH)
          : resting[i]!.inner,
      };
    }
    const width = Math.max(c.width, rowWidth - others);
    return { id: c.id, width, bar: false, handle: false, inner: width };
  });
  return { columns, total: sum(columns.map((c) => c.width)), zoomed };
}

/**
 * The row while a divider is dragged: what was on screen when the drag began
 * (`start`), the dragged column at `width` (at least {@link MIN_COLUMN_WIDTH})
 * and the leaf growing back to fill the row if it would leave a gap. Nothing
 * else moves, so the divider stays under the pointer — the fit would
 * re-balance the columns left of it and pull it away. The fit applies again
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

/**
 * The inner width a column's pane keeps during a motion: a column that
 * narrows keeps the width it had (clipped by its box) until the motion ends,
 * so its content does not re-wrap every frame; one growing lays out at its
 * target at once and is revealed as its box grows.
 */
export function heldInner(
  now: ColumnBox,
  before: ColumnBox | undefined,
): number {
  if (!before || before.bar || now.bar) return now.inner;
  return Math.max(now.inner, before.inner);
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
