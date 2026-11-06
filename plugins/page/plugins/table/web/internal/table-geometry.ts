// Where the table's rows and columns are on screen, read from the DOM — the
// one input the grid's chrome (grips, insert points, add bars, resize handles,
// drop lines) is placed from. Measured AFTER a render, never derived from
// state, so the chrome only ever draws what is on screen: a column the same
// write just inserted has no geometry until it is drawn, and so no chrome.

/** A box edge pair, in px relative to the grid's host box. */
export interface Span {
  start: number;
  end: number;
}

export interface TableGeometry {
  /** The `<table>` element's own box. */
  table: { left: number; top: number; width: number; height: number };
  /** Each column, left to right (from the header row's cells). */
  cols: Span[];
  /** Each row, top to bottom, the header first. */
  rows: Span[];
}

/** Measure `table` relative to `host`. */
export function measureTable(
  host: HTMLElement,
  table: HTMLTableElement,
): TableGeometry {
  const origin = host.getBoundingClientRect();
  const box = table.getBoundingClientRect();
  const trs = Array.from(table.rows);
  const head = trs[0] ? Array.from(trs[0].cells) : [];
  return {
    table: {
      left: box.left - origin.left,
      top: box.top - origin.top,
      width: box.width,
      height: box.height,
    },
    cols: head.map((cell) => {
      const r = cell.getBoundingClientRect();
      return { start: r.left - origin.left, end: r.right - origin.left };
    }),
    rows: trs.map((tr) => {
      const r = tr.getBoundingClientRect();
      return { start: r.top - origin.top, end: r.bottom - origin.top };
    }),
  };
}

export function sameGeometry(
  a: TableGeometry | null,
  b: TableGeometry,
): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** The gaps between spans: gap k sits before span k, gap n after the last. */
export function gaps(spans: readonly Span[]): number[] {
  if (spans.length === 0) return [];
  return [...spans.map((s) => s.start), spans[spans.length - 1]!.end];
}

/** The index of the span containing `p`, or the nearest one. */
export function spanAt(spans: readonly Span[], p: number): number {
  let best = 0;
  let bestDistance = Infinity;
  spans.forEach((s, i) => {
    const d = p < s.start ? s.start - p : p > s.end ? p - s.end : 0;
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

/** The gap nearest `p`, among gaps `from..to` (inclusive). */
export function nearestGap(
  edges: readonly number[],
  p: number,
  from = 0,
  to = edges.length - 1,
): number {
  let best = from;
  for (let k = from; k <= to; k++) {
    if (Math.abs(edges[k]! - p) < Math.abs(edges[best]! - p)) best = k;
  }
  return best;
}

/** An insert point: before column `k` (k < cols), or before row `k` (1 ≤ k < rows). */
export type InsertPoint = { kind: "col" | "row"; k: number };

/** How near a border's meeting with the outer edge the pointer must come for its "+". */
const NEAR_ALONG = 24;
const NEAR_ACROSS_OUT = 24;
const NEAR_ACROSS_IN = 14;
const NEAR_ROW_ALONG = 11;

/**
 * The insert point the pointer at (`x`, `y`) — host px — is near: a column
 * border meeting the table's top edge, or a row border meeting its left edge.
 * Not the exact intersection: within reach of it, so the "+" appears as the
 * pointer approaches. The left edge's first gap (above the header) is never
 * one — a table keeps its header first — and the far edges are the add bars'.
 */
export function insertPointNear(
  g: TableGeometry,
  x: number,
  y: number,
): InsertPoint | null {
  const { table } = g;
  if (y > table.top - NEAR_ACROSS_OUT && y < table.top + NEAR_ACROSS_IN) {
    const edges = gaps(g.cols);
    const k = nearestGap(edges, x, 0, g.cols.length - 1);
    if (Math.abs(edges[k]! - x) < NEAR_ALONG) return { kind: "col", k };
  }
  if (
    g.rows.length > 1 &&
    x > table.left - NEAR_ACROSS_OUT &&
    x < table.left + NEAR_ACROSS_IN
  ) {
    const edges = gaps(g.rows);
    const k = nearestGap(edges, y, 1, g.rows.length - 1);
    if (Math.abs(edges[k]! - y) < NEAR_ROW_ALONG) return { kind: "row", k };
  }
  return null;
}
