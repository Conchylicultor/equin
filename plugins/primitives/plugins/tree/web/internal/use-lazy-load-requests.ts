import { useEffect, useRef } from "react";
import type { LazyChildren, TreeNode } from "../../core";
import type { TreeItem } from "./types";

/**
 * Ask a lazy source for the children of every OPEN, VISIBLE, never-listed node.
 *
 * Declarative on purpose: the request follows from the tree's state, not from a
 * gesture, so every way a node comes to be open — a chevron click, expand-all,
 * reveal-on-select, an expand map restored from localStorage on reload — asks
 * exactly the same way. A change callback would miss the restored case (nothing
 * changed), leaving a reloaded tree's open folders empty forever.
 *
 * "Visible" = every ancestor open, walked on the UNSEARCHED forest: a node
 * folded away inside a collapsed parent is not shown, so it is not fetched, and
 * a search (which force-opens its matches) never fans out listings.
 *
 * The same walk tells the source which nodes are open (`onOpenChange`, when it
 * has one), each time that set changes, so a source keeping listings live can
 * let go of a node once it closes.
 *
 * Each node is asked at most once per `unloaded` spell: the set of asked ids is
 * pruned as soon as a node's state leaves `unloaded`, so a source that later
 * drops a listing back to `unloaded` (invalidation) is asked again.
 */
export function useLazyLoadRequests<T extends TreeItem>(
  forest: readonly TreeNode<T>[],
  lazy: LazyChildren<T> | undefined,
): void {
  const asked = useRef(new Set<string>());
  /** The open set last handed to `onOpenChange`, by id (null: never). */
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!lazy) return;
    const due: TreeNode<T>[] = [];
    const open: TreeNode<T>[] = [];
    const stillUnloaded = new Set<string>();
    const walk = (nodes: readonly TreeNode<T>[]) => {
      for (const node of nodes) {
        if (!node.expanded) continue;
        if (lazy.hasChildren(node)) {
          open.push(node);
          if (lazy.state(node).kind === "unloaded") {
            stillUnloaded.add(node.id);
            if (!asked.current.has(node.id)) due.push(node);
          }
        }
        walk(node.children);
      }
    };
    walk(forest);
    const openKey = open.map((n) => n.id).join("\n");
    if (lazy.onOpenChange && openKey !== lastOpen.current) {
      lastOpen.current = openKey;
      // open-set-sync: the source's liveness follows the tree's open state, which only the tree knows — told once per change of the set, before any load it asks for
      lazy.onOpenChange(open);
    }
    for (const id of asked.current) {
      if (!stillUnloaded.has(id)) asked.current.delete(id);
    }
    for (const node of due) {
      asked.current.add(node.id);
      // load-on-open: a lazy source's listing is requested from the tree's open state (chevron, expand-all, reveal, restored expand map) — an external fetch, not derivable in render, and deduped per unloaded spell by the `asked` ref
      lazy.load(node);
    }
  }, [forest, lazy]);
}
