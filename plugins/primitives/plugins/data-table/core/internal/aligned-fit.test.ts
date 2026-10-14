import { describe, expect, test } from "bun:test";
import { fitAlignedColumns } from "./aligned-fit";

const kind = { id: "kind", px: 140, dropOrder: 1 };
const modified = { id: "modified", px: 96, dropOrder: 2 };
const size = { id: "size", px: 80 };
const cols = [kind, modified, size];
const ids = (c: { id: string }[]) => c.map((x) => x.id);

describe("fitAlignedColumns", () => {
  test("keeps every column when the label has its room", () => {
    // 316 of columns + 3 gaps of 4 = 328; 328 + 160 = 488.
    expect(
      ids(fitAlignedColumns(cols, { budget: 488, gap: 4, minLabel: 160 })),
    ).toEqual(["kind", "modified", "size"]);
  });

  test("drops in dropOrder, keeping the unnumbered column longest", () => {
    expect(
      ids(fitAlignedColumns(cols, { budget: 487, gap: 4, minLabel: 160 })),
    ).toEqual(["modified", "size"]);
    expect(
      ids(fitAlignedColumns(cols, { budget: 300, gap: 4, minLabel: 160 })),
    ).toEqual(["size"]);
    expect(
      ids(fitAlignedColumns(cols, { budget: 200, gap: 4, minLabel: 160 })),
    ).toEqual([]);
  });

  test("unnumbered columns give way rightmost first", () => {
    const a = { id: "a", px: 100 };
    const b = { id: "b", px: 100 };
    expect(
      ids(fitAlignedColumns([a, b], { budget: 250, gap: 0, minLabel: 100 })),
    ).toEqual(["a"]);
  });
});
