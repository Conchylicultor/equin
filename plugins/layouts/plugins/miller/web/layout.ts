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
}

export interface ColumnBox {
  id: string;
  /** The column box's width, its divider included. */
  width: number;
  /** Drawn as a collapsed bar. */
  bar: boolean;
  /** Carries a divider (drag to resize, chevron to collapse). */
  handle: boolean;
  /** The pane's own width inside the box: the box less its divider. */
  inner: number;
}

export interface RowLayout {
  columns: ColumnBox[];
  /** Sum of the column widths — the row's scroll width. */
  total: number;
  /** The zoomed column's id, when a zoom is in effect. */
  zoomed: string | null;
}

/**
 * Lay the row out ("scroll", Finder-style): every column at its own width; a
 * user-collapsed non-leaf column a bar; when the columns are narrower than the
 * row the leaf grows to fill the rest (never below its own width), when wider
 * the row overflows and scrolls.
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
  const boxes = input.map((c, i) => {
    const last = i === n - 1;
    const bar = zoomed !== null ? c.id !== zoomed : !last && c.collapsed;
    return {
      id: c.id,
      width: bar ? BAR_WIDTH : c.width,
      bar,
      handle: zoomed === null && !bar && !last,
    };
  });
  const fill =
    zoomed !== null ? boxes.find((b) => b.id === zoomed) : boxes[n - 1];
  if (fill) {
    const others = boxes.reduce((s, b) => (b === fill ? s : s + b.width), 0);
    fill.width = Math.max(fill.width, rowWidth - others);
  }
  const columns = boxes.map((b) => ({
    ...b,
    inner: b.bar ? 0 : b.width - (b.handle ? HANDLE_WIDTH : 0),
  }));
  return {
    columns,
    total: columns.reduce((s, c) => s + c.width, 0),
    zoomed,
  };
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
