import { useMemo } from "react";
import type { ExpandChange, TreeNode } from "../../core";
import type { TreeItem } from "./types";

/**
 * The two questions a per-row "fold/unfold everything below me" affordance asks,
 * answered for EVERY row of a tree from a single walk.
 *
 * The shape matters as much as the answers. `getAllExpanded` is the render-time
 * half — every row with children calls it on every render — so it must be a map
 * lookup, not a walk. `getSubtreeChanges` is the click-time half, called once
 * per gesture, so it may walk the subtree it is about to rewrite.
 */
export type SubtreeExpandIndex = {
  /** Is every expandable node in this subtree (the root itself included) open? */
  getAllExpanded(id: string): boolean;
  /** The batch that flips the whole subtree. Computed at CLICK time, O(subtree). */
  getSubtreeChanges(id: string, next: boolean): ExpandChange[];
};

/**
 * Build the index in ONE post-order walk of the whole forest — O(n) for the
 * render, not O(n) per row.
 *
 * The per-row shape is what forces this. The predecessor hook took `(rows,
 * rootId)` and rebuilt a parent map over all rows on every call; with one call
 * per row-with-children that is O(n × k) — worst case quadratic — paid on every
 * expand/collapse of the tasks list, the agents list and the Studio plugin
 * tree. Answering all n rows from one walk is the fix, and it is only possible
 * from the built tree (where a node already holds its children) rather than
 * from the flat rows.
 *
 * **A leaf is vacuously "all expanded."** It has nothing below it to be open or
 * closed, so it must not drag an ancestor's answer to false — a folder whose
 * children are all files is fully unfolded. This matches the semantics the three
 * consumer copies had, where the collected set only ever contained nodes that
 * themselves have children.
 */
export function buildSubtreeExpandIndex<T extends TreeItem>(
  tree: readonly TreeNode<T>[],
): SubtreeExpandIndex {
  const byId = new Map<string, TreeNode<T>>();
  const allExpanded = new Map<string, boolean>();

  const walk = (node: TreeNode<T>): boolean => {
    byId.set(node.id, node);
    if (node.children.length === 0) {
      allExpanded.set(node.id, true);
      return true;
    }
    let all = node.expanded;
    for (const child of node.children) {
      // Every child is walked even once `all` is already false: the index
      // answers for EVERY node, so short-circuiting here would leave the
      // unvisited descendants with no entry at all.
      if (!walk(child)) all = false;
    }
    allExpanded.set(node.id, all);
    return all;
  };
  for (const root of tree) walk(root);

  return {
    // An unknown id answers `true` rather than throwing: a row can ask about
    // itself mid-churn — while a live-state update has replaced `rows` but the
    // row's own render still holds the previous node — and "nothing left to
    // unfold" is the same answer a leaf gets, so the button simply reads
    // "collapse" for one frame instead of crashing the tree.
    getAllExpanded: (id) => allExpanded.get(id) ?? true,
    getSubtreeChanges: (id, next) => {
      const root = byId.get(id);
      if (!root) return [];
      const out: ExpandChange[] = [];
      const collect = (node: TreeNode<T>) => {
        // Childless nodes carry an `expanded` flag that paints nothing, so
        // writing it would be a pure no-op that still costs a serialization of
        // the host's expand map.
        if (node.children.length === 0) return;
        if (node.expanded !== next) out.push({ id: node.id, expanded: next });
        for (const child of node.children) collect(child);
      };
      collect(root);
      return out;
    },
  };
}

/**
 * Memoize the index on the tree it was built from.
 *
 * `tree` must be the FULL forest — `buildTree(scoped)` — never the searched or
 * windowed projection a renderer paints. The windowed path renders only the rows
 * intersecting the viewport, and the search path hands out clones forced to
 * `expanded: true`; an index built from either would answer about the slice on
 * screen rather than about the subtree the button claims to fold.
 */
export function useSubtreeExpandIndex<T extends TreeItem>(
  tree: readonly TreeNode<T>[],
): SubtreeExpandIndex {
  return useMemo(() => buildSubtreeExpandIndex(tree), [tree]);
}
