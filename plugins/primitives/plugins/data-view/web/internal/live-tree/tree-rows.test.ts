import { describe, expect, test } from "bun:test";
import {
  assembleTreeRows,
  scopedToRoots,
  type TreeRowAccess,
} from "./tree-rows";

type R = { id: string; parent: string | null; rank: string; ws?: string };
const r = (id: string, parent: string | null, rank = "a", ws = "w"): R => ({
  id,
  parent,
  rank,
  ws,
});
const access: TreeRowAccess<R> = {
  idOf: (x) => x.id,
  parentOf: (x) => x.parent,
};
const byRank = (a: R, b: R) => a.rank.localeCompare(b.rank);
const ids = (rows: readonly R[]) => rows.map((x) => x.id);
const levels = (entries: [string, R[]][]) => new Map(entries);

describe("assembleTreeRows", () => {
  test("the roots in read order, each once, then the levels hanging from them", () => {
    const out = assembleTreeRows({
      access,
      roots: [r("a", null), r("b", null), r("a", null)],
      levels: levels([
        ["a", [r("a1", "a")]],
        ["a1", [r("a11", "a1")]],
      ]),
      compare: byRank,
    });
    expect(ids(out.rows)).toEqual(["a", "b", "a1", "a11"]);
    expect(out.parentOf.get("a11")).toBe("a1");
    expect(out.orphans.size).toBe(0);
  });

  test("a level whose parent no window draws is not drawn (its reader is about to go)", () => {
    const out = assembleTreeRows({
      access,
      roots: [r("a", null)],
      levels: levels([["gone", [r("x1", "gone")]]]),
      compare: byRank,
    });
    expect(ids(out.rows)).toEqual(["a"]);
  });

  test("a pin lands among its siblings by the comparator, after the loaded ones when last, and its level follows it", () => {
    const out = assembleTreeRows({
      access,
      roots: [r("p", null, "a")],
      levels: levels([
        ["p", [r("h1", "p", "b"), r("h2", "p", "d")]],
        ["c", [r("c1", "c")]],
      ]),
      pins: [r("c", "p", "c"), r("z", "p", "z"), r("h1", "p", "b")],
      compare: byRank,
    });
    expect(ids(out.rows)).toEqual(["p", "h1", "c", "h2", "z", "c1"]);
  });

  test("a hit hangs from its pinned ancestors (matches plus ancestors)", () => {
    const out = assembleTreeRows({
      access,
      roots: [r("leaf", "mid", "a")],
      pins: [r("root", null, "a"), r("mid", "root", "a")],
      compare: byRank,
    });
    expect(out.parentOf.get("leaf")).toBe("mid");
    expect(out.parentOf.get("mid")).toBe("root");
    expect(out.orphans.size).toBe(0);
  });

  test("a hit whose parent is nowhere is an orphan, drawn — never dropped", () => {
    const out = assembleTreeRows({
      access,
      roots: [r("leaf", "outside", "a")],
      compare: byRank,
    });
    expect(ids(out.rows)).toEqual(["leaf"]);
    expect([...out.orphans]).toEqual(["leaf"]);
  });

  test("a pending reparent is drawn beside its anchor in the destination, out of its source", () => {
    const moved = r("m", "src", "a");
    const out = assembleTreeRows({
      access,
      roots: [r("src", null), r("dst", null, "b")],
      levels: levels([
        ["src", [moved]],
        ["dst", [r("d1", "dst", "a"), r("d2", "dst", "b")]],
      ]),
      compare: byRank,
      moves: [{ row: moved, parentId: "dst", targetId: "d1", zone: "after" }],
    });
    expect(ids(out.rows)).toEqual(["src", "dst", "d1", "m", "d2"]);
    expect(out.parentOf.get("m")).toBe("dst");
  });

  test("a move with no anchor, or one not drawn, lands after the destination's loaded children", () => {
    const moved = r("m", null, "z");
    const out = assembleTreeRows({
      access,
      roots: [moved, r("dst", null, "b")],
      levels: levels([["dst", [r("d1", "dst", "a")]]]),
      compare: byRank,
      moves: [{ row: moved, parentId: "dst", targetId: "far", zone: "before" }],
    });
    expect(ids(out.rows)).toEqual(["dst", "d1", "m"]);
  });

  test("a move under a destination not drawn is not drawn", () => {
    const moved = r("m", null, "z");
    const out = assembleTreeRows({
      access,
      roots: [moved, r("a", null)],
      compare: byRank,
      moves: [
        { row: moved, parentId: "closed", targetId: null, zone: "after" },
      ],
    });
    expect(ids(out.rows)).toEqual(["a"]);
  });
});

describe("scopedToRoots", () => {
  test("keeps the rows under a root the scope admits; an orphan is its own root", () => {
    const tree = assembleTreeRows({
      access,
      roots: [
        r("h1", "in", "a"),
        r("h2", "out", "a"),
        r("lost", "nowhere", "a", "w"),
      ],
      pins: [r("in", null, "a", "w"), r("out", null, "a", "x")],
      compare: byRank,
    });
    const kept = scopedToRoots(tree, access.idOf, (root) => root.ws === "w");
    expect(ids(kept).sort()).toEqual(["h1", "in", "lost"]);
  });
});
