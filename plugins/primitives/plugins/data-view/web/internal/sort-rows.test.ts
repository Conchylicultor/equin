import { describe, expect, it } from "bun:test";
import type { FieldDef, SortRule } from "../../core";
import { makeSortComparator } from "./sort-rows";

interface Row {
  id: string;
  num?: number;
  name?: string;
  when?: Date;
  flag?: boolean;
}

const fields: FieldDef<Row>[] = [
  { id: "num", label: "Num", value: (r) => r.num ?? null },
  { id: "name", label: "Name", value: (r) => r.name ?? null },
  { id: "when", label: "When", value: (r) => r.when ?? null },
  { id: "flag", label: "Flag", value: (r) => r.flag ?? null },
  // A field with no `value` projection — rules referencing it are dangling.
  { id: "novalue", label: "No value" },
];

/** Sort a copy of `rows` through the comparator (or return as-is when null). */
function sortRows(rules: SortRule[], rows: Row[]): Row[] {
  const cmp = makeSortComparator(rules, fields);
  const copy = [...rows];
  if (cmp) copy.sort(cmp);
  return copy;
}

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("makeSortComparator", () => {
  it("sorts a single number rule asc and desc", () => {
    const rows: Row[] = [
      { id: "a", num: 3 },
      { id: "b", num: 1 },
      { id: "c", num: 2 },
    ];
    expect(ids(sortRows([{ fieldId: "num", direction: "asc" }], rows))).toEqual(
      ["b", "c", "a"],
    );
    expect(
      ids(sortRows([{ fieldId: "num", direction: "desc" }], rows)),
    ).toEqual(["a", "c", "b"]);
  });

  it("sorts a single string rule asc and desc", () => {
    const rows: Row[] = [
      { id: "a", name: "Charlie" },
      { id: "b", name: "alpha" },
      { id: "c", name: "Bravo" },
    ];
    expect(
      ids(sortRows([{ fieldId: "name", direction: "asc" }], rows)),
    ).toEqual(["b", "c", "a"]);
    expect(
      ids(sortRows([{ fieldId: "name", direction: "desc" }], rows)),
    ).toEqual(["a", "c", "b"]);
  });

  it("sorts a single Date rule chronologically", () => {
    const rows: Row[] = [
      { id: "a", when: new Date("2024-03-01") },
      { id: "b", when: new Date("2024-01-01") },
      { id: "c", when: new Date("2024-02-01") },
    ];
    expect(
      ids(sortRows([{ fieldId: "when", direction: "asc" }], rows)),
    ).toEqual(["b", "c", "a"]);
    expect(
      ids(sortRows([{ fieldId: "when", direction: "desc" }], rows)),
    ).toEqual(["a", "c", "b"]);
  });

  it("sorts a single bool rule (false before true asc)", () => {
    const rows: Row[] = [
      { id: "a", flag: true },
      { id: "b", flag: false },
      { id: "c", flag: true },
    ];
    expect(
      ids(sortRows([{ fieldId: "flag", direction: "asc" }], rows)),
    ).toEqual(["b", "a", "c"]);
    expect(
      ids(sortRows([{ fieldId: "flag", direction: "desc" }], rows)),
    ).toEqual(["a", "c", "b"]);
  });

  it("breaks ties with the secondary rule", () => {
    const rows: Row[] = [
      { id: "a", num: 1, name: "z" },
      { id: "b", num: 1, name: "a" },
      { id: "c", num: 0, name: "m" },
    ];
    const rules: SortRule[] = [
      { fieldId: "num", direction: "asc" },
      { fieldId: "name", direction: "asc" },
    ];
    expect(ids(sortRows(rules, rows))).toEqual(["c", "b", "a"]);
  });

  it("applies direction independently per rule", () => {
    const rows: Row[] = [
      { id: "a", num: 1, name: "a" },
      { id: "b", num: 1, name: "z" },
      { id: "c", num: 0, name: "m" },
    ];
    // primary asc on num, secondary desc on name.
    const rules: SortRule[] = [
      { fieldId: "num", direction: "asc" },
      { fieldId: "name", direction: "desc" },
    ];
    expect(ids(sortRows(rules, rows))).toEqual(["c", "b", "a"]);
  });

  it("skips a dangling rule (unknown field / no value) and uses the next", () => {
    const rows: Row[] = [
      { id: "a", num: 2 },
      { id: "b", num: 1 },
    ];
    const rules: SortRule[] = [
      { fieldId: "missing", direction: "asc" }, // unknown field
      { fieldId: "novalue", direction: "asc" }, // field exists, no `value`
      { fieldId: "num", direction: "asc" },
    ];
    expect(ids(sortRows(rules, rows))).toEqual(["b", "a"]);
  });

  it("returns null when every rule is dangling", () => {
    expect(
      makeSortComparator(
        [
          { fieldId: "missing", direction: "asc" },
          { fieldId: "novalue", direction: "desc" },
        ],
        fields,
      ),
    ).toBeNull();
    expect(makeSortComparator([], fields)).toBeNull();
  });

  it("ignores a `data`-only field: display data is never a sort key", () => {
    const withData: FieldDef<Row>[] = [
      ...fields,
      {
        id: "avatar",
        label: "Avatar",
        type: "spec",
        data: (r) => ({ glyph: r.name }),
        sortable: true,
      },
    ];
    expect(
      makeSortComparator([{ fieldId: "avatar", direction: "asc" }], withData),
    ).toBeNull();
    // A later resolvable rule still sorts, the `data` rule dropped ahead of it.
    const cmp = makeSortComparator(
      [
        { fieldId: "avatar", direction: "asc" },
        { fieldId: "num", direction: "asc" },
      ],
      withData,
    );
    const rows: Row[] = [
      { id: "a", num: 2, name: "a" },
      { id: "b", num: 1, name: "b" },
    ];
    expect(ids([...rows].sort(cmp!))).toEqual(["b", "a"]);
  });

  it("is stable: equal rows keep source order", () => {
    const rows: Row[] = [
      { id: "a", num: 1 },
      { id: "b", num: 1 },
      { id: "c", num: 1 },
      { id: "d", num: 1 },
    ];
    expect(ids(sortRows([{ fieldId: "num", direction: "asc" }], rows))).toEqual(
      ["a", "b", "c", "d"],
    );
  });

  it("a pinned rule then a user rule: folders first, then by date", () => {
    interface Entry {
      id: string;
      kind: "dir" | "file";
      mtime: number;
    }
    const entryFields: FieldDef<Entry>[] = [
      {
        id: "folders",
        label: "Folders",
        type: "number",
        value: (r) => (r.kind === "dir" ? 0 : 1),
      },
      {
        id: "modified",
        label: "Modified",
        type: "number",
        value: (r) => r.mtime,
      },
    ];
    const rows: Entry[] = [
      { id: "f-old", kind: "file", mtime: 1 },
      { id: "d-new", kind: "dir", mtime: 4 },
      { id: "f-new", kind: "file", mtime: 3 },
      { id: "d-old", kind: "dir", mtime: 2 },
    ];
    const cmp = makeSortComparator(
      [
        { fieldId: "folders", direction: "asc", pinned: true },
        { fieldId: "modified", direction: "desc" },
      ],
      entryFields,
    );
    expect(cmp).not.toBeNull();
    expect([...rows].sort(cmp!).map((r) => r.id)).toEqual([
      "d-new",
      "d-old",
      "f-new",
      "f-old",
    ]);
  });
});
