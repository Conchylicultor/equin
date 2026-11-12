import { describe, expect, it } from "bun:test";
import type { DataViewSection } from "./types";
import { applySectionMove, applySectionMoves } from "./section-move";

const section = (key: string, rows: string[]): DataViewSection<string> => ({
  key,
  label: key,
  count: { kind: "exact", n: rows.length },
  entries: rows.map((row) => ({ row, key: row })),
});

const SECTIONS = [section("A", ["a1", "a2"]), section("B", ["b1", "b2"])];
const keys = (sections: DataViewSection<string>[]) =>
  sections.map(
    (s) => `${s.key}:${s.entries.map((e) => e.key).join(",")}:${s.count.n}`,
  );

describe("applySectionMove", () => {
  it("moves the entry beside its anchor and fixes both counts", () => {
    expect(
      keys(
        applySectionMove(SECTIONS, {
          id: "a1",
          dest: { groupKey: "B", targetId: "b1", zone: "after" },
        }),
      ),
    ).toEqual(["A:a2:1", "B:b1,a1,b2:3"]);
  });

  it("puts an unanchored entry at the section's head, also into an empty one", () => {
    expect(
      keys(applySectionMove(SECTIONS, { id: "b2", dest: { groupKey: "A" } })),
    ).toEqual(["A:b2,a1,a2:3", "B:b1:1"]);
    const withEmpty = [...SECTIONS, section("C", [])];
    expect(
      keys(applySectionMove(withEmpty, { id: "a1", dest: { groupKey: "C" } })),
    ).toEqual(["A:a2:1", "B:b1,b2:2", "C:a1:1"]);
  });

  it("is the sections themselves when there is nothing to draw differently", () => {
    expect(
      applySectionMove(SECTIONS, { id: "zz", dest: { groupKey: "B" } }),
    ).toBe(SECTIONS);
    expect(
      applySectionMove(SECTIONS, { id: "a1", dest: { groupKey: "A" } }),
    ).toBe(SECTIONS);
    expect(
      applySectionMove(SECTIONS, { id: "a1", dest: { groupKey: "Z" } }),
    ).toBe(SECTIONS);
  });

  it("applies several moves in order", () => {
    expect(
      keys(
        applySectionMoves(SECTIONS, [
          { id: "a1", dest: { groupKey: "B" } },
          { id: "b2", dest: { groupKey: "A" } },
        ]),
      ),
    ).toEqual(["A:b2,a2:2", "B:a1,b1:2"]);
  });
});
