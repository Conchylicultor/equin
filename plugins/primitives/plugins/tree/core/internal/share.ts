import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { FlatTreeLine } from "./flatten";
import type { TreeNode } from "./tree";

/**
 * Structural sharing of a tree across renders: every forest a tree model
 * builds is new objects (`buildTree` spreads each row, a search clones what it
 * keeps), so a renderer memoizing its rows by the line it draws would redraw
 * every row whenever anything changed. A sharing keeps the object it handed
 * out last for a node or a line that is unchanged — deeply: a node is kept
 * when its own fields are the same and its children are the very nodes kept
 * for them (shared bottom-up), so a kept object never carries a stale subtree.
 *
 * One sharing per tree (it remembers the last forest and lines it shared);
 * O(nodes) per call.
 */
export type TreeSharing<T> = {
  /** `forest`, each node the previous one wherever it is unchanged. */
  forest(forest: readonly TreeNode<T>[]): TreeNode<T>[];
  /** `lines`, each line the previous one wherever it is unchanged (call it on
   *  lines flattened from a shared forest — a line is kept only while its
   *  node is the very node it held). */
  lines(lines: readonly FlatTreeLine<T>[]): FlatTreeLine<T>[];
};

export function createTreeSharing<T extends { id: string }>(): TreeSharing<T> {
  let prevNodes = new Map<string, TreeNode<T>>();
  let prevLines = new Map<string, FlatTreeLine<T>>();
  return {
    forest(forest) {
      const next = new Map<string, TreeNode<T>>();
      const share = (node: TreeNode<T>): TreeNode<T> => {
        const children = node.children.map(share);
        const prev = prevNodes.get(node.id);
        const shared =
          prev !== undefined &&
          sameArray(prev.children, children) &&
          sameOwnFields(prev, node)
            ? prev
            : sameArray(node.children, children)
              ? node
              : { ...node, children };
        next.set(node.id, shared);
        return shared;
      };
      const out = forest.map(share);
      prevNodes = next;
      return out;
    },
    lines(lines) {
      const next = new Map<string, FlatTreeLine<T>>();
      const out = lines.map((line) => {
        const key = lineKey(line);
        const prev = prevLines.get(key);
        const shared = prev !== undefined && sameLine(prev, line) ? prev : line;
        next.set(key, shared);
        return shared;
      });
      prevLines = next;
      return out;
    },
  };
}

function lineKey<T extends { id: string }>(line: FlatTreeLine<T>): string {
  // NUL-prefixed: never a node id.
  return line.kind === "node" ? line.node.id : `\u0000p:${line.parent.id}`;
}

function sameLine<T>(a: FlatTreeLine<T>, b: FlatTreeLine<T>): boolean {
  if (a.depth !== b.depth) return false;
  if (a.kind === "node") return b.kind === "node" && a.node === b.node;
  return (
    b.kind === "placeholder" &&
    a.parent === b.parent &&
    sameOwnFields(a.placeholder, b.placeholder)
  );
}

function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Every own field but `children` the same (a rank by value: ranks are
 *  re-minted from their key on every projection). */
function sameOwnFields(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const key of keys) {
    if (key === "children") continue;
    if (!(key in rb)) return false;
    const x = ra[key];
    const y = rb[key];
    if (Object.is(x, y)) continue;
    if (x instanceof Rank && y instanceof Rank && Rank.equals(x, y)) continue;
    return false;
  }
  return true;
}
