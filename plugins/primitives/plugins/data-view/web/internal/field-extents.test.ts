import { describe, expect, test } from "bun:test";
import type { FieldDef } from "../../core";
import { computeFieldExtents } from "./field-extents";

type Row = { plays: number | null; name: string };
const rows: Row[] = [
  { plays: 4, name: "a" },
  { plays: null, name: "b" },
  { plays: 40, name: "c" },
];
const plays: FieldDef<Row> = {
  id: "plays",
  label: "Plays",
  value: (r) => r.plays,
  extent: true,
};
const name: FieldDef<Row> = { id: "name", label: "Name", value: (r) => r.name };
const as = (fs: FieldDef<Row>[]) => fs as FieldDef<unknown>[];

describe("computeFieldExtents", () => {
  test("one extent per `extent: true` field, over the rows' numeric values", () => {
    const extents = computeFieldExtents(rows, as([plays, name]));
    expect([...extents.keys()]).toEqual(["plays"]);
    expect(extents.get("plays")).toEqual({ min: 4, max: 40 });
  });

  test("no field asks: no row is visited", () => {
    let visited = 0;
    const counting: FieldDef<Row> = {
      ...name,
      value: (r) => {
        visited++;
        return r.name;
      },
    };
    expect(computeFieldExtents(rows, as([counting])).size).toBe(0);
    expect(visited).toBe(0);
  });

  test("no numeric value in the view: null; no `value` at all: throws", () => {
    expect(
      computeFieldExtents([{ plays: null, name: "x" }], as([plays])).get(
        "plays",
      ),
    ).toBeNull();
    const { value: _v, ...valueless } = plays;
    expect(() => computeFieldExtents(rows, as([valueless]))).toThrow(
      /declares `extent: true` but has no `value`/,
    );
  });
});
