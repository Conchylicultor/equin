import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { TreeNode } from "./tree";
import {
  flatNodeIds,
  flattenVisible,
  treeKeyMove,
  type KeyboardLine,
} from "./flatten";

type Row = {
  id: string;
  parentId: string | null;
  rank: Rank;
  expanded: boolean;
};

function node(
  id: string,
  parentId: string | null,
  children: TreeNode<Row>[] = [],
  expanded = false,
): TreeNode<Row> {
  return { id, parentId, rank: Rank.from("a0"), expanded, children };
}

// src (open) ─ main.ts
//            └ util.ts
// docs (closed, lazily listed)
// README.md
const main = node("src/main.ts", "src");
const util = node("src/util.ts", "src");
const src = node("src", null, [main, util], true);
const docs = node("docs", null);
const readme = node("README.md", null);
const lines: KeyboardLine<Row>[] = [
  { kind: "node", node: src },
  { kind: "node", node: main },
  { kind: "node", node: util },
  { kind: "node", node: docs },
  { kind: "placeholder" },
  { kind: "node", node: readme },
];
const lazy = {
  hasChildren: (r: Row) => r.id === "docs",
  state: () => ({ kind: "unloaded" as const }),
  load: () => {},
};

describe("treeKeyMove", () => {
  test("down and up walk the painted rows, skipping placeholders", () => {
    expect(treeKeyMove("ArrowDown", "src", lines, lazy)).toEqual({
      kind: "focus",
      id: "src/main.ts",
    });
    expect(treeKeyMove("ArrowDown", "docs", lines, lazy)).toEqual({
      kind: "focus",
      id: "README.md",
    });
    expect(treeKeyMove("ArrowUp", "src", lines, lazy)).toEqual({
      kind: "none",
    });
    expect(treeKeyMove("End", "src", lines, lazy)).toEqual({
      kind: "focus",
      id: "README.md",
    });
  });

  test("right opens a closed row with (possible) children, else steps in", () => {
    expect(treeKeyMove("ArrowRight", "docs", lines, lazy)).toEqual({
      kind: "expand",
      id: "docs",
      expanded: true,
    });
    expect(treeKeyMove("ArrowRight", "src", lines, lazy)).toEqual({
      kind: "focus",
      id: "src/main.ts",
    });
    expect(treeKeyMove("ArrowRight", "README.md", lines, lazy)).toEqual({
      kind: "none",
    });
  });

  test("left closes an open row, else steps out to the parent", () => {
    expect(treeKeyMove("ArrowLeft", "src", lines, lazy)).toEqual({
      kind: "expand",
      id: "src",
      expanded: false,
    });
    expect(treeKeyMove("ArrowLeft", "src/util.ts", lines, lazy)).toEqual({
      kind: "focus",
      id: "src",
    });
    expect(treeKeyMove("ArrowLeft", "README.md", lines, lazy)).toEqual({
      kind: "none",
    });
  });
});

describe("flattenVisible", () => {
  test("descends only into open nodes, with each open lazy node's placeholder after its children", () => {
    const openDocs = node("docs", null, [], true);
    const flat = flattenVisible([src, openDocs, readme], (n) =>
      n.id === "docs" ? { kind: "loading" } : null,
    );
    expect(
      flat.map((l) =>
        l.kind === "node"
          ? `${l.depth}:${l.node.id}`
          : `${l.depth}:…${l.parent.id}`,
      ),
    ).toEqual([
      "0:src",
      "1:src/main.ts",
      "1:src/util.ts",
      "0:docs",
      "1:…docs",
      "0:README.md",
    ]);
    expect(flatNodeIds(flat)).toEqual([
      "src",
      "src/main.ts",
      "src/util.ts",
      "docs",
      "README.md",
    ]);
  });

  test("a closed node hides its subtree and asks for no placeholder", () => {
    const closed = node("src", null, [main, util], false);
    const asked: string[] = [];
    const flat = flattenVisible([closed], (n) => {
      asked.push(n.id);
      return null;
    });
    expect(flatNodeIds(flat)).toEqual(["src"]);
    expect(asked).toEqual([]);
  });
});
