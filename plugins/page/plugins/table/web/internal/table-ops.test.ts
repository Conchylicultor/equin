import { describe, expect, test } from "bun:test";
import type { RichText } from "@plugins/page/plugins/editor/core";
import { tableBlock, type TableData } from "../../core";
import {
  clearColumn,
  clearRow,
  deleteColumn,
  deleteRow,
  duplicateColumn,
  duplicateRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  resizeColumn,
  setAlign,
  setCell,
} from "./table-ops";

const r = (s: string): RichText => (s ? [{ text: s }] : []);
const t = (grid: string[][], widths?: number[]): TableData => ({
  align: grid[0]!.map(() => null),
  header: grid[0]!.map(r),
  rows: grid.slice(1).map((row) => row.map(r)),
  ...(widths ? { widths } : {}),
});
/** The grid as strings, header first — what the user sees. */
const cells = (d: TableData): string[][] =>
  [d.header, ...d.rows].map((row) =>
    row.map((c) => c.map((x) => x.text).join("")),
  );
/** Every op's output is a table the write boundary accepts. */
const valid = (d: TableData): TableData => {
  expect(tableBlock.safeParse(d).success).toBe(true);
  return d;
};

const base = t(
  [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ],
  [100, 200],
);

describe("rows (row 0 is the header)", () => {
  test("setCell writes one cell, header included", () => {
    expect(cells(valid(setCell(base, 0, 1, r("B"))))).toEqual([
      ["a", "B"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(cells(setCell(base, 2, 0, r("x")))[2]).toEqual(["x", "4"]);
  });

  test("insert, duplicate, clear and delete a body row", () => {
    expect(cells(valid(insertRow(base, 1)))).toEqual([
      ["a", "b"],
      ["", ""],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(cells(valid(insertRow(base, 3))).at(-1)).toEqual(["", ""]);
    expect(cells(valid(duplicateRow(base, 1)))).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(cells(valid(clearRow(base, 0)))[0]).toEqual(["", ""]);
    expect(cells(valid(deleteRow(base, 1)))).toEqual([
      ["a", "b"],
      ["3", "4"],
    ]);
  });

  test("the header stays first: no row above it, none moved over it, never deleted", () => {
    expect(() => insertRow(base, 0)).toThrow();
    expect(() => deleteRow(base, 0)).toThrow();
    expect(() => duplicateRow(base, 0)).toThrow();
    expect(() => moveRow(base, 1, 0)).toThrow();
    expect(() => moveRow(base, 0, 2)).toThrow();
  });

  test("moveRow drops a row into a GAP", () => {
    expect(cells(valid(moveRow(base, 1, 3)))).toEqual([
      ["a", "b"],
      ["3", "4"],
      ["1", "2"],
    ]);
    expect(cells(moveRow(base, 2, 1))).toEqual(cells(moveRow(base, 1, 3)));
    // Dropping a row on either side of itself is no move at all.
    expect(moveRow(base, 1, 1)).toEqual(base);
    expect(moveRow(base, 1, 2)).toEqual(base);
  });
});

describe("columns: cells, align and widths move together", () => {
  test("insertColumn gives a sized table the width it is handed", () => {
    const d = valid(insertColumn(base, 1, 140));
    expect(cells(d)[0]).toEqual(["a", "", "b"]);
    expect(d.align).toEqual([null, null, null]);
    expect(d.widths).toEqual([100, 140, 200]);
    // A content-sized table stays content-sized.
    expect(insertColumn(t([["a"]]), 1, 140).widths).toBeUndefined();
  });

  test("duplicate, move and delete carry alignment and width", () => {
    const aligned = setAlign(base, 1, "right");
    const dup = valid(duplicateColumn(aligned, 1));
    expect(cells(dup)[1]).toEqual(["1", "2", "2"]);
    expect(dup.align).toEqual([null, "right", "right"]);
    expect(dup.widths).toEqual([100, 200, 200]);

    const moved = valid(moveColumn(aligned, 1, 0));
    expect(cells(moved)[0]).toEqual(["b", "a"]);
    expect(moved.align).toEqual(["right", null]);
    expect(moved.widths).toEqual([200, 100]);

    const gone = valid(deleteColumn(aligned, 0));
    expect(cells(gone)).toEqual([["b"], ["2"], ["4"]]);
    expect(gone.widths).toEqual([200]);
  });

  test("clearColumn empties the column and nothing else", () => {
    expect(cells(valid(clearColumn(base, 0)))).toEqual([
      ["", "b"],
      ["", "2"],
      ["", "4"],
    ]);
  });

  test("a table keeps at least one column", () => {
    expect(() => deleteColumn(t([["a"], ["1"]]), 0)).toThrow();
  });
});

describe("resizeColumn", () => {
  test("a content-sized table freezes at the drawn widths first", () => {
    const d = valid(resizeColumn(t([["a", "b"]]), 0, 150.4, [120, 80]));
    expect(d.widths).toEqual([150, 80]);
  });

  test("a stale width list (columns changed under it) is replaced by the drawn one", () => {
    const stale = { ...t([["a", "b", "c"]]), widths: [100, 200] };
    expect(resizeColumn(stale, 2, 90, [50, 60, 70]).widths).toEqual([
      50, 60, 90,
    ]);
  });

  test("the drawn widths must cover every column", () => {
    expect(() => resizeColumn(t([["a", "b"]]), 0, 10, [1])).toThrow();
  });
});
