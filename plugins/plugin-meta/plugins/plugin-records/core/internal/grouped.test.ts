import { expect, test } from "bun:test";
import { groupedByOwner, readGrouped } from "./grouped";
import { recordKey } from "./keys";
import { createMemoryRecordStore, type RecordStore } from "./store";

/** A memory store counting the keys each table is asked for. */
function counted(): { store: RecordStore; asked: Map<string, number> } {
  const inner = createMemoryRecordStore();
  const asked = new Map<string, number>();
  return {
    asked,
    store: {
      ...inner,
      getMany(table, keys) {
        asked.set(table, (asked.get(table) ?? 0) + keys.length);
        return inner.getMany(table, keys);
      },
    },
  };
}

const k = (s: string): string => recordKey(s);
// Synthetic plugin paths, spelled so `plugin-refs-resolve` does not read them
// as references to real plugins.
const pj = (rel: string): string => `plugins/${rel}`;

test("a group is read member by member until every member exists, then as one record", () => {
  const { store, asked } = counted();
  store.putMany("file", [
    [k("a"), "A"],
    [k("b"), "B"],
  ]);
  const groups = [[k("a"), k("b")], [k("c")]];

  // c is missing: its group is not written; a and b's is.
  const first = readGrouped(store, "file", groups);
  expect([...first.values()].sort()).toEqual(["A", "B"]);
  expect(asked.get("file")).toBe(3);

  store.putMany("file", [[k("c"), "C"]]);
  asked.clear();
  const second = readGrouped(store, "file", groups);
  expect(second.get(k("c"))).toBe("C");
  // a+b answered by their group record; only c's members asked.
  expect(asked.get("file")).toBe(1);

  asked.clear();
  const third = readGrouped(store, "file", groups);
  expect(third).toEqual(second);
  // c is a group of one: read as itself, no group record of its own.
  expect(asked.get("file")).toBe(1);
  expect(asked.get("group")).toBe(1);
});

test("a group is keyed by its members alone, in any order", () => {
  const { store, asked } = counted();
  store.putMany("file", [
    [k("a"), "A"],
    [k("b"), "B"],
  ]);
  readGrouped(store, "file", [[k("a"), k("b")]]);
  asked.clear();
  const again = readGrouped(store, "file", [[k("b"), k("a"), k("a")]]);
  expect(again.get(k("a"))).toBe("A");
  expect(asked.get("file")).toBeUndefined();
  // Another member set (a changed file is a new key) is a new group.
  store.putMany("file", [[k("b2"), "B2"]]);
  const changed = readGrouped(store, "file", [[k("a"), k("b2")]]);
  expect(changed.get(k("b2"))).toBe("B2");
  expect(asked.get("file")).toBe(2);
});

test("paths group by the plugin owning them", () => {
  expect(
    groupedByOwner(
      [
        pj("a/web/x.ts"),
        pj("a/plugins/b/core/y.ts"),
        pj("a/core/z.ts"),
        "bun.lock",
      ],
      ["1", "2", "3", "4"],
    ),
  ).toEqual([["1", "3"], ["2"], ["4"]]);
});
