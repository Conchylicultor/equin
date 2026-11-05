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
  | Extract<TreeChildrenState, { kind: "failed" }>
  | MorePlaceholder;

/**
 * The "Load more" line of a `partial` level: drawn AFTER the children it has
 * loaded (never instead of them), focusable — Enter grows the level.
 */
export type MorePlaceholder = Omit<
  Extract<TreeChildrenState, { kind: "partial" }>,
  "kind"
> & { kind: "more" };

// A "Load more" line's focus id: its parent's id, NUL-prefixed so it can
// never be a row id.
const MORE_PREFIX = "\u0000more:";

/** The focus id of the "Load more" line under `parentId` (`data-tree-id`). */
export function moreLineId(parentId: string): string {
  return `${MORE_PREFIX}${parentId}`;
}

/** Whether a focus id names a "Load more" line rather than a row. */
export function isMoreLineId(id: string): boolean {
  return id.startsWith(MORE_PREFIX);
}

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
 * - `partial` → the "Load more" line, after whatever children are loaded (a
 *   paged level: more exist past them). Under a search it shows nothing, as an
 *   unlisted node does: the search opened it, nobody asked.
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
    case "partial": {
      if (searching) return null;
      const { kind: _kind, ...paging } = state;
      return { ...paging, kind: "more" };
    }
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

/** One painted line as the keyboard walks it: a placeholder is stepped over,
 *  except a "Load more" line, which is a stop of its own (Enter grows its
 *  level). Every `FlatTreeLine` is one. */
export type KeyboardLine<T> =
  | { kind: "node"; node: TreeNode<T> }
  | {
      kind: "placeholder";
      parent?: TreeNode<T>;
      placeholder?: ChildPlaceholder;
    };

/**
 * The move a key asks for on the focused line — pure, so it is testable alone.
 * `focus` names a row (`line: "node"`: it is also selected) or a "Load more"
 * line (`line: "more"`, its {@link moreLineId}: focused only); `load` grows the
 * level whose "Load more" line Enter was pressed on.
 */
export type TreeKeyMove =
  | { kind: "focus"; id: string; line: "node" | "more" }
  | { kind: "expand"; id: string; expanded: boolean }
  | { kind: "load"; loadMore: () => void }
  | { kind: "none" };

/**
 * What a key does on the line `id`, given the painted lines (WAI-ARIA tree
 * pattern): ↑/↓ the previous / next stop, Home/End the first / last (the
 * LOADED ends: a "Load more" line is a stop); → opens a closed row that has
 * (or may have) children, else steps into its first child; ← closes an open
 * row, else steps out to its parent. On a "Load more" line, Enter grows its
 * level and ← steps out to the level's parent.
 */
export function treeKeyMove<T extends Expandable>(
  key: string,
  id: string,
  lines: readonly KeyboardLine<T>[],
  lazyChildren: LazyChildren<T> | undefined,
): TreeKeyMove {
  type Stop =
    | { kind: "node"; id: string; node: TreeNode<T> }
    | { kind: "more"; id: string; parent: TreeNode<T>; more: MorePlaceholder };
  const stops: Stop[] = lines.flatMap((l): Stop[] => {
    if (l.kind === "node")
      return [{ kind: "node", id: l.node.id, node: l.node }];
    if (l.parent && l.placeholder?.kind === "more") {
      return [
        {
          kind: "more",
          id: moreLineId(l.parent.id),
          parent: l.parent,
          more: l.placeholder,
        },
      ];
    }
    return [];
  });
  const at = stops.findIndex((s) => s.id === id);
  if (at < 0) return { kind: "none" };
  const stop = stops[at]!;
  const focus = (target: Stop | undefined): TreeKeyMove =>
    target
      ? {
          kind: "focus",
          id: target.id,
          line: target.kind === "node" ? "node" : "more",
        }
      : { kind: "none" };
  const nodeStop = (n: TreeNode<T> | undefined): Stop | undefined =>
    n === undefined ? undefined : { kind: "node", id: n.id, node: n };
  switch (key) {
    case "ArrowDown":
      return focus(stops[at + 1]);
    case "ArrowUp":
      return focus(stops[at - 1]);
    case "Home":
      return focus(stops[0]);
    case "End":
      return focus(stops[stops.length - 1]);
  }
  if (stop.kind === "more") {
    if (key === "Enter") return { kind: "load", loadMore: stop.more.loadMore };
    if (key === "ArrowLeft") return focus(nodeStop(stop.parent));
    return { kind: "none" };
  }
  const node = stop.node;
  const hasChildren =
    node.children.length > 0 || (lazyChildren?.hasChildren(node) ?? false);
  switch (key) {
    case "ArrowRight":
      if (!hasChildren) return { kind: "none" };
      if (!node.expanded) return { kind: "expand", id, expanded: true };
      return focus(nodeStop(node.children[0]));
    case "ArrowLeft": {
      if (hasChildren && node.expanded)
        return { kind: "expand", id, expanded: false };
      const parent = stops.find(
        (s) => s.kind === "node" && s.id === node.parentId,
      );
      return focus(parent);
    }
    default:
      return { kind: "none" };
  }
}
