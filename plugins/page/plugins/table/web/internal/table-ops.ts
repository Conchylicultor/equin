import type { RichText } from "@plugins/page/plugins/editor/core";
import type { TableAlign, TableData } from "../../core";

// The table's edits, as pure functions of its data. Rows are addressed on ONE
// axis with the header included — row 0 is the header, row k ≥ 1 is
// `rows[k - 1]` — because that is the grid the user sees and moves through.
// Every function keeps the payload's invariants: `align` (and `widths`, when
// set) stay exactly as long as the header, the header stays first, and a table
// keeps at least one column.

/** The number of rows on the grid's axis, header included. */
export function rowCount(d: TableData): number {
  return d.rows.length + 1;
}

/** The cells of grid row `r` (0 = the header). */
export function rowAt(d: TableData, r: number): readonly RichText[] {
  return r === 0 ? d.header : d.rows[r - 1]!;
}

function withGrid(d: TableData, grid: RichText[][]): TableData {
  const [header, ...rows] = grid;
  return { ...d, header: header!, rows };
}

function grid(d: TableData): RichText[][] {
  return [d.header, ...d.rows];
}

/** Insert `item` at `at` (0 ≤ at ≤ length). */
function insertAt<T>(list: readonly T[], at: number, item: T): T[] {
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/**
 * Move the item at `from` to the GAP `to` (0 ≤ to ≤ length, gaps counted on the
 * list before the move) — the index a drop line between two items names.
 */
export function moveIndex<T>(
  list: readonly T[],
  from: number,
  to: number,
): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, item!);
  return out;
}

/** Where the item at `from` lands after a move to gap `to`. */
export function movedTo(from: number, to: number): number {
  return to > from ? to - 1 : to;
}

const blank = (width: number): RichText[] =>
  Array.from({ length: width }, () => []);

/** Replace one cell's runs. */
export function setCell(
  d: TableData,
  r: number,
  c: number,
  runs: RichText,
): TableData {
  return withGrid(
    d,
    grid(d).map((row, i) =>
      i === r ? row.map((cell, j) => (j === c ? runs : cell)) : row,
    ),
  );
}

/** Insert an empty row at gap `at` of the grid (1 ≤ at: never above the header). */
export function insertRow(d: TableData, at: number): TableData {
  if (at < 1) throw new Error(`insertRow: gap ${at} is above the header`);
  return withGrid(d, insertAt(grid(d), at, blank(d.header.length)));
}

/** A copy of row `r` right below it. The header is not a body row to copy. */
export function duplicateRow(d: TableData, r: number): TableData {
  if (r < 1) throw new Error("duplicateRow: the header row has no duplicate");
  return withGrid(d, insertAt(grid(d), r + 1, [...rowAt(d, r)]));
}

/** Empty every cell of row `r`. */
export function clearRow(d: TableData, r: number): TableData {
  return withGrid(
    d,
    grid(d).map((row, i) => (i === r ? blank(row.length) : row)),
  );
}

/** Delete body row `r`. A table keeps its header (GFM has no headerless table). */
export function deleteRow(d: TableData, r: number): TableData {
  if (r < 1) throw new Error("deleteRow: a table keeps its header row");
  return withGrid(
    d,
    grid(d).filter((_, i) => i !== r),
  );
}

/** Move body row `from` to grid gap `to` (≥ 1: the header stays first). */
export function moveRow(d: TableData, from: number, to: number): TableData {
  if (from < 1 || to < 1) throw new Error("moveRow: the header stays first");
  return withGrid(d, moveIndex(grid(d), from, to));
}

/** Map every per-column list (cells of each row, align, widths) together. */
function mapColumns(
  d: TableData,
  f: <T>(list: readonly T[]) => T[],
): TableData {
  return {
    ...d,
    align: f(d.align),
    header: f(d.header),
    rows: d.rows.map((row) => f(row)),
    ...(d.widths ? { widths: f(d.widths) } : {}),
  };
}

/**
 * Insert an empty column at gap `at`. A table with fixed widths gives it the
 * width `width` — the caller's choice, since only the surface knows a pixel.
 */
export function insertColumn(
  d: TableData,
  at: number,
  width: number,
): TableData {
  return {
    ...d,
    align: insertAt(d.align, at, null),
    header: insertAt(d.header, at, []),
    rows: d.rows.map((row) => insertAt(row, at, [])),
    ...(d.widths ? { widths: insertAt(d.widths, at, width) } : {}),
  };
}

/** A copy of column `c` (cells, alignment, width) right after it. */
export function duplicateColumn(d: TableData, c: number): TableData {
  return mapColumns(d, (list) => insertAt(list, c + 1, list[c]!));
}

/** Empty every cell of column `c`. */
export function clearColumn(d: TableData, c: number): TableData {
  return withGrid(
    d,
    grid(d).map((row) => row.map((cell, j) => (j === c ? [] : cell))),
  );
}

/** Delete column `c`. A table keeps at least one column. */
export function deleteColumn(d: TableData, c: number): TableData {
  if (d.header.length <= 1) {
    throw new Error("deleteColumn: a table keeps at least one column");
  }
  return mapColumns(d, (list) => list.filter((_, j) => j !== c));
}

/** Move column `from` to gap `to`, its alignment and width with it. */
export function moveColumn(d: TableData, from: number, to: number): TableData {
  return mapColumns(d, (list) => moveIndex(list, from, to));
}

/** Set column `c`'s alignment (`null` = none, a plain `---`). */
export function setAlign(
  d: TableData,
  c: number,
  align: TableAlign,
): TableData {
  return { ...d, align: d.align.map((a, j) => (j === c ? align : a)) };
}

/**
 * Set column `c` to `width` px. A table still sizing its columns to their
 * content is first frozen at `current` — every column's width as drawn — so
 * resizing one column leaves the others exactly where the user sees them.
 */
export function resizeColumn(
  d: TableData,
  c: number,
  width: number,
  current: readonly number[],
): TableData {
  const base =
    d.widths && d.widths.length === d.header.length ? d.widths : current;
  if (base.length !== d.header.length) {
    throw new Error(
      `resizeColumn: ${base.length} widths for ${d.header.length} column(s)`,
    );
  }
  return {
    ...d,
    widths: base.map((w, j) => Math.round(j === c ? width : w)),
  };
}
