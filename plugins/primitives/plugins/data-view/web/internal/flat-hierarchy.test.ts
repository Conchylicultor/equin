import { describe, expect, it } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  PARENT_FIELD_ID,
  type FieldDef,
  type HierarchyConfig,
} from "../../core";
import { rootRows, withParentField } from "./flat-hierarchy";

type Row = { id: string; parent: string | null; title: string };

const ROWS: Row[] = [
  { id: "a", parent: null, title: "Alpha" },
  { id: "a1", parent: "a", title: "" },
  { id: "a11", parent: "a1", title: "Leaf" },
  { id: "orphan", parent: "gone", title: "Orphan" },
];
const key = (r: Row) => r.id;
const hierarchy: HierarchyConfig<Row> = {
  getParentId: (r) => r.parent,
  getRank: () => Rank.from("a0"),
};
const title: FieldDef<Row> = {
  id: "title",
  label: "Title",
  type: "text",
  value: (r) => r.title,
};

describe("withParentField", () => {
  it("labels each row by its parent's primary field, falling back to the parent id", () => {
    const fields = withParentField([title], ROWS, key, hierarchy);
    const parent = fields.at(-1)!;
    expect(parent.id).toBe(PARENT_FIELD_ID);
    expect(parent.groupable).toBe(true);
    // a: root; a1: Alpha; a11: a1 has an empty title → its id; orphan: not loaded.
    expect(ROWS.map((r) => parent.value?.(r) ?? null)).toEqual([
      null,
      "Alpha",
      "a1",
      "gone",
    ]);
  });

  it("throws when a consumer field claims the reserved id", () => {
    expect(() =>
      withParentField(
        [title, { id: PARENT_FIELD_ID, label: "Mine" }],
        ROWS,
        key,
        hierarchy,
      ),
    ).toThrow(/reserved/);
  });
});

describe("rootRows", () => {
  it("keeps rows with no parent or a parent not among the rows", () => {
    expect(rootRows(ROWS, key, hierarchy).map(key)).toEqual(["a", "orphan"]);
  });
});
