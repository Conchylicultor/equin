import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  exactCount,
  type DataViewAttachConfig,
  type DataViewRowEntry,
  type DataViewSection,
} from "../../core";
import {
  attachRoots,
  attachedChildrenOpen,
  attachExpandKey,
  resolveAttach,
} from "./attach";
import { hangAttached } from "./use-data-view-sections";
import { makeFoldKeep } from "./fold-sections";

/** A queue-like row: a conversation `id` of task `task`, managed by `parent`. */
interface Row {
  id: string;
  task: string;
  parent: string | null;
  rank?: Rank;
}

const row = (id: string, task: string, parent: string | null = null): Row => ({
  id,
  task,
  parent,
});

const ATTACH: DataViewAttachConfig<Row> = {
  getKey: (r) => r.task,
  getParentKey: (r) => r.parent,
};

const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

describe("resolveAttach", () => {
  test("a row whose parent key is held attaches beneath it", () => {
    const rows = [row("s", "S"), row("a", "A", "S"), row("b", "B", "S")];
    const { roots, childrenOf } = resolveAttach(rows, ATTACH);
    expect(ids(roots)).toEqual(["s"]);
    expect(ids(childrenOf.get("S")!)).toEqual(["a", "b"]);
  });

  test("a parent no held row carries leaves the row top-level", () => {
    const { roots, childrenOf } = resolveAttach(
      [row("a", "A", "GONE")],
      ATTACH,
    );
    expect(ids(roots)).toEqual(["a"]);
    expect(childrenOf.size).toBe(0);
  });

  test("a self-parent stays top-level", () => {
    const { roots } = resolveAttach([row("a", "A", "A")], ATTACH);
    expect(ids(roots)).toEqual(["a"]);
  });

  test("a cycle hides nothing: both stay top-level, with what hangs from it", () => {
    const rows = [row("a", "A", "B"), row("b", "B", "A"), row("c", "C", "A")];
    const { roots, childrenOf } = resolveAttach(rows, ATTACH);
    expect(ids(roots)).toEqual(["a", "b", "c"]);
    expect(childrenOf.size).toBe(0);
  });

  test("multi-level: a child's children hang beneath it", () => {
    const rows = [row("s", "S"), row("w", "W", "S"), row("x", "X", "W")];
    const { roots, childrenOf } = resolveAttach(rows, ATTACH);
    expect(ids(roots)).toEqual(["s"]);
    expect(ids(childrenOf.get("S")!)).toEqual(["w"]);
    expect(ids(childrenOf.get("W")!)).toEqual(["x"]);
  });

  test("attachRoots is the rows that would not attach", () => {
    const rows = [row("s", "S"), row("a", "A", "S"), row("o", "O", "GONE")];
    expect(ids(attachRoots(rows, ATTACH))).toEqual(["s", "o"]);
  });
});

const section = (
  key: string | null,
  rows: readonly Row[],
): DataViewSection<Row> => ({
  key,
  count: exactCount(rows.length),
  entries: rows.map((r) => ({ row: r, key: r.id })),
});

const shape = (entries: readonly DataViewRowEntry<Row>[]): unknown[] =>
  entries.map((e) => (e.children ? { [e.key]: shape(e.children) } : e.key));

describe("hangAttached", () => {
  test("children hang under the entry whose rows carry the key, counts untouched", () => {
    const rows = [row("s", "S"), row("a", "A", "S"), row("t", "T")];
    const resolved = resolveAttach(rows, ATTACH);
    const [s] = hangAttached([section(null, resolved.roots)], resolved, {
      attach: ATTACH,
      rowKey: (r) => r.id,
    });
    expect(shape(s!.entries)).toEqual([{ s: ["a"] }, "t"]);
    expect(s!.count).toEqual(exactCount(2));
  });

  test("an aggregate's member claims its key's children", () => {
    // Two conversations of the supervisor's task, collapsed to one entry.
    const rows = [row("s1", "S"), row("s2", "S"), row("a", "A", "S")];
    const resolved = resolveAttach(rows, ATTACH);
    const parent: DataViewSection<Row> = {
      key: null,
      count: exactCount(1),
      entries: [
        {
          row: rows[1]!,
          key: "s1",
          aggregateCount: 2,
          members: [rows[0]!, rows[1]!],
        },
      ],
    };
    const [s] = hangAttached([parent], resolved, {
      attach: ATTACH,
      rowKey: (r) => r.id,
    });
    expect(shape(s!.entries)).toEqual([{ s1: ["a"] }]);
  });

  test("children are aggregated and rank-ordered like a section", () => {
    const [r0, r1, r2] = Rank.nBetween(null, null, 3);
    const rows: Row[] = [
      row("s", "S"),
      { ...row("b", "B", "S"), rank: r1 },
      { ...row("a1", "A", "S"), rank: r2 },
      { ...row("a2", "A", "S"), rank: r0 },
    ];
    const resolved = resolveAttach(rows, ATTACH);
    const [s] = hangAttached([section(null, resolved.roots)], resolved, {
      attach: ATTACH,
      rowKey: (r) => r.id,
      manualRank: (r) => r.rank ?? null,
      aggregate: { getKey: (r) => r.task },
    });
    const children = s!.entries[0]!.children!;
    // a2 (the lowest rank) leads A's aggregate, which sorts before B.
    expect(children.map((c) => [c.key, c.aggregateCount ?? 1])).toEqual([
      ["a2", 2],
      ["b", 1],
    ]);
  });

  test("a key's children hang under the first entry holding it, once", () => {
    const rows = [row("s1", "S"), row("s2", "S"), row("a", "A", "S")];
    const resolved = resolveAttach(rows, ATTACH);
    const sections = hangAttached(
      [section("one", [rows[0]!]), section("two", [rows[1]!])],
      resolved,
      { attach: ATTACH, rowKey: (r) => r.id },
    );
    expect(shape(sections[0]!.entries)).toEqual([{ s1: ["a"] }]);
    expect(shape(sections[1]!.entries)).toEqual(["s2"]);
  });
});

describe("the fold keeps a parent whose attached row is selected", () => {
  test("a selected child keeps its parent past the limit", () => {
    const rows = [row("t", "T"), row("s", "S"), row("a", "A", "S")];
    const resolved = resolveAttach(rows, ATTACH);
    const [s] = hangAttached([section(null, resolved.roots)], resolved, {
      attach: ATTACH,
      rowKey: (r) => r.id,
    });
    const keep = makeFoldKeep<Row>(null, {
      limit: 1,
      selectedRowId: "a",
      rowKey: (r) => r.id,
    });
    expect(keep(s!.entries)).toEqual([true, true]);
  });
});

describe("attachedChildrenOpen", () => {
  const rows = [row("s", "S"), row("a", "A", "S")];
  const resolved = resolveAttach(rows, ATTACH);
  const [s] = hangAttached([section(null, resolved.roots)], resolved, {
    attach: ATTACH,
    rowKey: (r) => r.id,
  });
  const parent = s!.entries[0]!;
  const ctx = {
    attach: ATTACH,
    expanded: undefined,
    selectedRowId: undefined,
    rowKey: (r: Row) => r.id,
  };

  test("closed by default, open under defaultExpanded", () => {
    expect(attachedChildrenOpen(parent, ctx)).toBe(false);
    expect(
      attachedChildrenOpen(parent, {
        ...ctx,
        attach: { ...ATTACH, defaultExpanded: true },
      }),
    ).toBe(true);
  });

  test("the expand map wins over the default", () => {
    expect(
      attachedChildrenOpen(parent, {
        ...ctx,
        attach: { ...ATTACH, defaultExpanded: true },
        expanded: { [attachExpandKey("s")]: false },
      }),
    ).toBe(false);
  });

  test("a selected child opens its parent whatever the map says", () => {
    expect(
      attachedChildrenOpen(parent, {
        ...ctx,
        expanded: { [attachExpandKey("s")]: false },
        selectedRowId: "a",
      }),
    ).toBe(true);
  });

  test("the expand key never collides with the row's own", () => {
    expect(attachExpandKey("s")).not.toBe("s");
  });
});
