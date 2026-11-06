// A rectangular selection of cells, on the grid axis the user sees (row 0 is
// the header, as in `table-ops.ts`). A range is two corners — where it was
// started (`anchor`) and where it was last extended to (`focus`) — so
// Shift+click and Shift+arrows move the focus and leave the anchor where it is.

/** One cell of the grid: row `r` (0 = the header), column `c`. */
export interface Cell {
  r: number;
  c: number;
}

export interface CellRange {
  anchor: Cell;
  focus: Cell;
}

/** A range's rows `r0..r1` and columns `c0..c1`, both inclusive. */
export interface CellBounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** The arrow keys a range moves by. */
export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export function isArrowKey(key: string): key is ArrowKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  );
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

/** The range holding one cell. */
export function cellRange(cell: Cell): CellRange {
  return { anchor: cell, focus: cell };
}

/** Every cell of a `rows` × `cols` table. */
export function wholeTable(rows: number, cols: number): CellRange {
  return { anchor: { r: 0, c: 0 }, focus: { r: rows - 1, c: cols - 1 } };
}

export function boundsOf({ anchor, focus }: CellRange): CellBounds {
  return {
    r0: Math.min(anchor.r, focus.r),
    r1: Math.max(anchor.r, focus.r),
    c0: Math.min(anchor.c, focus.c),
    c1: Math.max(anchor.c, focus.c),
  };
}

export function inBounds(b: CellBounds, r: number, c: number): boolean {
  return r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
}

/**
 * The range kept inside a `rows` × `cols` table — a write (a deleted row, an
 * agent's rewrite) can shrink the table under a selection. `null` once the
 * table has no cell left to hold.
 */
export function clampRange(
  range: CellRange,
  rows: number,
  cols: number,
): CellRange | null {
  if (rows < 1 || cols < 1) return null;
  const clamp = ({ r, c }: Cell): Cell => ({
    r: Math.min(r, rows - 1),
    c: Math.min(c, cols - 1),
  });
  return { anchor: clamp(range.anchor), focus: clamp(range.focus) };
}

/** The cell one arrow step from `cell`, held at the table's edges. */
export function stepCell(
  cell: Cell,
  key: ArrowKey,
  rows: number,
  cols: number,
): Cell {
  const { r, c } = cell;
  switch (key) {
    case "ArrowUp":
      return { r: Math.max(0, r - 1), c };
    case "ArrowDown":
      return { r: Math.min(rows - 1, r + 1), c };
    case "ArrowLeft":
      return { r, c: Math.max(0, c - 1) };
    case "ArrowRight":
      return { r, c: Math.min(cols - 1, c + 1) };
  }
}
