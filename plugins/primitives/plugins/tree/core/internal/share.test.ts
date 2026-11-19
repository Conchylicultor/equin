import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { buildTree, type TreeNode } from "./tree";
import { flattenVisible } from "./flatten";
import { createTreeSharing } from "./share";

type Row = {
  id: string;
  parentId: string | null;
  rank: Rank;
  expanded: boolean;
  title: string;
};

// Every call mints new objects, ranks included — as a projection does.
function rows(titles: Record<string, string> = {}): Row[] {
  const row = (id: string, parentId: string | null, expanded = true) => ({
    id,
    parentId,
    rank: Rank.from(`a${id}`),
    expanded,
    title: titles[id] ?? id,
  });
  // 1 ─ 2 ─ 3
  //   └ 4
  // 5
  return [
    row("1", null),
    row("2", "1"),
    row("3", "2"),
    row("4", "1"),
    row("5", null),
  ];
}

const flatten = (forest: TreeNode<Row>[]) => flattenVisible(forest, () => null);

describe("createTreeSharing", () => {
  test("an unchanged rebuild hands back the very same nodes and lines", () => {
    const sharing = createTreeSharing<Row>();
    const a = sharing.forest(buildTree(rows()));
    const linesA = sharing.lines(flatten(a));
    const b = sharing.forest(buildTree(rows()));
    const linesB = sharing.lines(flatten(b));
    expect(b[0]).toBe(a[0]!);
    expect(b[1]).toBe(a[1]!);
    linesB.forEach((line, i) => expect(line).toBe(linesA[i]!));
  });

  test("a changed node is new, and so is every ancestor; the rest are kept", () => {
    const sharing = createTreeSharing<Row>();
    const linesA = sharing.lines(flatten(sharing.forest(buildTree(rows()))));
    const linesB = sharing.lines(
      flatten(sharing.forest(buildTree(rows({ "3": "renamed" })))),
    );
    const byId = (lines: typeof linesA) =>
      new Map(
        lines.map((l) => [l.kind === "node" ? l.node.id : "", l] as const),
      );
    const [a, b] = [byId(linesA), byId(linesB)];
    // 3 changed; 2 and 1 hold it, so they are new too (a kept node never
    // carries a stale subtree).
    for (const id of ["3", "2", "1"]) expect(b.get(id)).not.toBe(a.get(id)!);
    for (const id of ["4", "5"]) expect(b.get(id)).toBe(a.get(id)!);
    const three = b.get("3")!;
    expect(three.kind === "node" && three.node.title).toBe("renamed");
  });

  test("a search narrowing the children re-mints the parent, keeps the leaves", () => {
    const sharing = createTreeSharing<Row>();
    const full = sharing.forest(buildTree(rows()));
    // The search's clone: forced open, children narrowed.
    const one = full[0]!;
    const narrowed: TreeNode<Row>[] = [
      { ...one, expanded: true, children: [one.children[1]!] },
    ];
    const shared = sharing.forest(narrowed);
    expect(shared[0]).not.toBe(one);
    expect(shared[0]!.children[0]).toBe(one.children[1]!);
  });

  test("a line moving to another depth is a new line", () => {
    const sharing = createTreeSharing<Row>();
    const a = sharing.lines(flatten(sharing.forest(buildTree(rows()))));
    const moved = rows().map((r) =>
      r.id === "4" ? { ...r, parentId: "2" } : r,
    );
    const b = sharing.lines(flatten(sharing.forest(buildTree(moved))));
    const four = (lines: typeof a) =>
      lines.find((l) => l.kind === "node" && l.node.id === "4")!;
    expect(four(b)).not.toBe(four(a));
    expect(four(b).depth).toBe(2);
  });
});
