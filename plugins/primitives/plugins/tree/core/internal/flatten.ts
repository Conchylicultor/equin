import type { TreeNode } from "./tree";
import type { LazyChildren, TreeChildrenState } from "../types";

type Expandable = { id: string; parentId: string | null; expanded: boolean };

/**
 * What an expanded, lazily-listed node shows beneath it in place of children it
 * does not have (yet): the listing in flight, the listing's failure, or the
 * listing's confirmed emptiness. `null` = nothing to show (the children are
 * there, or the node is not lazy / not open).
 */
export type ChildPlaceholder =
  | { kind: "loading" }
  | { kind: "empty" }
  | Extract<TreeChildrenState, { kind: "failed" }>;

/**
 * The ONE answer to "does this open node need a placeholder child row?", shared
 * by every renderer of a flattened tree, so they all paint the same rows.
 *
 * - `unloaded` / `loading` with no children yet → loading (an unloaded open node
 *   is about to be asked — see `useLazyLoadRequests`). With children already
 *   there it is a refresh, and the rows it has stay as they are. Under a search
 *   an `unloaded` node shows nothing: the search opened it, nobody asked.
 * - `failed` → the failure, children or not: a stale listing must not read as a
 *   current one.
 * - `loaded` with no children → empty — but not while a search narrows the tree,
 *   where "no children" means "no matching children".
 */
export function childPlaceholder<T extends Expandable>(
  node: T & { children: readonly unknown[] },
  lazy: LazyChildren<T> | undefined,
  searching: boolean,
): ChildPlaceholder | null {
  if (!lazy || !node.expanded || !lazy.hasChildren(node)) return null;
  const state = lazy.state(node);
  switch (state.kind) {
    case "failed":
      return state;
    case "loaded":
      return node.children.length === 0 && !searching
        ? { kind: "empty" }
        : null;
    case "unloaded":
      // A search force-opens what it keeps without asking for listings (see
      // `useLazyLoadRequests`), so an unlisted node it opened is not "about to
      // load" — it simply shows nothing below it.
      if (searching) return null;
      return node.children.length === 0 ? { kind: "loading" } : null;
    case "loading":
      return node.children.length === 0 ? { kind: "loading" } : null;
  }
}

/** One painted line of a flattened tree: a node, or the placeholder child row
 *  an open lazy node shows in place of children it does not have yet. */
export type FlatTreeLine<T> =
  | { kind: "node"; node: TreeNode<T>; depth: number }
  | {
      kind: "placeholder";
      parent: TreeNode<T>;
      placeholder: ChildPlaceholder;
      depth: number;
    };

/**
 * The painted tree as a flat list, in paint order: a DFS that descends into a
 * node's children only when it is expanded, followed by the node's placeholder
 * row when it has one. Every renderer reads this one list — the windowed rows,
 * the keyboard's line walk and multi-select's shift-range order — so what is
 * painted, what the keys step through and what a range selects cannot diverge.
 */
export function flattenVisible<T extends { expanded: boolean }>(
  forest: readonly TreeNode<T>[],
  placeholderOf: (node: TreeNode<T>) => ChildPlaceholder | null,
): FlatTreeLine<T>[] {
  const out: FlatTreeLine<T>[] = [];
  const walk = (nodes: readonly TreeNode<T>[], depth: number) => {
    for (const node of nodes) {
      out.push({ kind: "node", node, depth });
      if (!node.expanded) continue;
      walk(node.children, depth + 1);
      const placeholder = placeholderOf(node);
      if (placeholder) {
        out.push({
          kind: "placeholder",
          parent: node,
          placeholder,
          depth: depth + 1,
        });
      }
    }
  };
  walk(forest, 0);
  return out;
}

/** The node ids of a flattened tree, in paint order (placeholders skipped). */
export function flatNodeIds<T extends { id: string }>(
  lines: readonly FlatTreeLine<T>[],
): string[] {
  return lines.flatMap((l) => (l.kind === "node" ? [l.node.id] : []));
}

/** One painted line as the keyboard walks it: placeholders are stepped over,
 *  so only their presence matters. Every `FlatTreeLine` is one. */
export type KeyboardLine<T> =
  { kind: "node"; node: TreeNode<T> } | { kind: "placeholder" };

/** The move a key asks for on the focused row — pure, so it is testable alone. */
export type TreeKeyMove =
  | { kind: "focus"; id: string }
  | { kind: "expand"; id: string; expanded: boolean }
  | { kind: "none" };

/**
 * What a key does on the row `id`, given the painted lines (WAI-ARIA tree
 * pattern): ↑/↓ the previous / next row, Home/End the first / last; → opens a
 * closed row that has (or may have) children, else steps into its first child;
 * ← closes an open row, else steps out to its parent.
 */
export function treeKeyMove<T extends Expandable>(
  key: string,
  id: string,
  lines: readonly KeyboardLine<T>[],
  lazyChildren: LazyChildren<T> | undefined,
): TreeKeyMove {
  const nodes = lines.flatMap((l) => (l.kind === "node" ? [l.node] : []));
  const at = nodes.findIndex((n) => n.id === id);
  if (at < 0) return { kind: "none" };
  const node = nodes[at]!;
  const focus = (target: TreeNode<T> | undefined): TreeKeyMove =>
    target ? { kind: "focus", id: target.id } : { kind: "none" };
  const hasChildren =
    node.children.length > 0 || (lazyChildren?.hasChildren(node) ?? false);
  switch (key) {
    case "ArrowDown":
      return focus(nodes[at + 1]);
    case "ArrowUp":
      return focus(nodes[at - 1]);
    case "Home":
      return focus(nodes[0]);
    case "End":
      return focus(nodes[nodes.length - 1]);
    case "ArrowRight":
      if (!hasChildren) return { kind: "none" };
      if (!node.expanded) return { kind: "expand", id, expanded: true };
      return focus(node.children[0]);
    case "ArrowLeft":
      if (hasChildren && node.expanded)
        return { kind: "expand", id, expanded: false };
      return focus(nodes.find((n) => n.id === node.parentId));
    default:
      return { kind: "none" };
  }
}
