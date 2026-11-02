import { describe, expect, test } from "bun:test";
import {
  routeTuple,
  tableLayoutRequirements,
  type Route,
  type TableChange,
  type TupleUse,
} from "./routing";

// A composite identity route (research/2026-11-02-global-live-composite-key-collections.md,
// Decision 2): a table keyed by a composite primary key has no `ids` (the
// change feed fills them only for a single-column key), so each changed row's
// host id is composed from its key columns, carried row-aligned in `keys`.
// The codec here is a stand-in: the router only calls it.

const compose = (parts: readonly string[]) => parts.join("|");
const route: Route = {
  id: "base",
  table: "cells",
  map: { kind: "identity", columns: ["surface", "row_key", "col"], compose },
  columns: ["surface", "row_key", "col", "value"],
  match: ["surface"],
};
const scoped = (surface: string): ReadonlyMap<string, TupleUse> =>
  new Map([
    ["base", { role: "membership", match: { surface: new Set([surface]) } }],
  ]);
const change = (
  op: TableChange["op"],
  keys: TableChange["keys"],
): TableChange => ({
  source: "feed",
  table: "cells",
  op,
  ids: null,
  keys,
  unchanged: null,
});

describe("composite identity routes", () => {
  test("the trigger layout carries every key column", () => {
    expect(tableLayoutRequirements([route])).toEqual([
      {
        table: "cells",
        carry: ["col", "row_key", "surface"],
        reads: [["col", "row_key", "surface", "value"]],
      },
    ]);
  });

  test("each row of the tuple's scope is one composed host id; other scopes' rows reach nothing", () => {
    const c = change("U", {
      surface: ["A", "B", "A"],
      row_key: ["r1", "r1", "r2"],
      col: ["c", "c", "c"],
    });
    const a = routeTuple(c, [route], scoped("A"));
    expect(a.kind).toBe("scoped");
    if (a.kind !== "scoped") throw new Error("unreachable");
    expect([...a.affected].sort()).toEqual(["A|r1|c", "A|r2|c"]);
    // A write to another scope is untouched — no load.
    const other = change("I", {
      surface: ["B"],
      row_key: ["r1"],
      col: ["c"],
    });
    expect(routeTuple(other, [route], scoped("A")).kind).toBe("untouched");
  });

  test("a delete names its rows as deleted", () => {
    const r = routeTuple(
      change("D", { surface: ["A"], row_key: ["r1"], col: ["c"] }),
      [route],
      scoped("A"),
    );
    if (r.kind !== "scoped") throw new Error(`got ${r.kind}`);
    expect([...r.deleted]).toEqual(["A|r1|c"]);
  });

  test("a scope move (old ∪ new carried) reaches both scopes", () => {
    // An UPDATE moving a row A → B: the feed carries the old and the new row.
    const move = change("U", {
      surface: ["A", "B"],
      row_key: ["r1", "r1"],
      col: ["c", "c"],
    });
    for (const [s, id] of [
      ["A", "A|r1|c"],
      ["B", "B|r1|c"],
    ] as const) {
      const r = routeTuple(move, [route], scoped(s));
      if (r.kind !== "scoped") throw new Error(`got ${r.kind}`);
      expect([...r.affected]).toEqual([id]);
    }
  });

  test("unknown parts are FULL: keys absent (over the cap), a column missing, a NULL part", () => {
    expect(routeTuple(change("U", null), [route], scoped("A")).kind).toBe(
      "full",
    );
    expect(
      routeTuple(
        change("U", { surface: ["A"], row_key: ["r1"] }),
        [route],
        scoped("A"),
      ).kind,
    ).toBe("full");
    expect(
      routeTuple(
        change("U", { surface: ["A"], row_key: ["r1"], col: [null] }),
        [route],
        scoped("A"),
      ).kind,
    ).toBe("full");
  });
});
