import { useMemo } from "react";
import type {
  ReorderNode,
  ReorderTree,
} from "@plugins/fields/plugins/reorder-tree/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { isNodeData, type ReorderNodeData, type ReorderState } from "./sorting";

// The writes an area's nodes make at rest: a header's collapse toggle
// (`patchNode`) and a node's own removal. Ordering, hiding and inserting are the
// Config pane's reorder-tree field, which writes the whole tree itself.

/**
 * An area's node writes, each materializing a fresh `items` tree into the slot's
 * user config layer. Stable identities: they read the latest state when they
 * fire.
 */
export interface ReorderAreaWrites {
  removeNode: (id: string) => void;
  patchNode: (renderId: string, partial: Record<string, unknown>) => void;
}

/**
 * Verbatim map over the raw `items` tree, applied to the node matching `id` at
 * the top level OR one level inside a container. Returning `null` from `fn`
 * removes the node; returning a `ReorderNode` replaces it. Reads never call this
 * — only in-app writes (patch/remove).
 */
function mapNodeById(
  tree: ReorderTree,
  id: string,
  fn: (node: ReorderNode) => ReorderNode | null,
): ReorderTree {
  const out: ReorderNode[] = [];
  for (const node of tree) {
    if (typeof node === "object" && "type" in node && node.id === id) {
      const next = fn(node);
      if (next !== null) out.push(next);
      continue;
    }
    if (
      typeof node === "object" &&
      "type" in node &&
      Array.isArray(node.items)
    ) {
      // Recurse one level into a container's members.
      const items: ReorderNode[] = [];
      let touched = false;
      for (const member of node.items) {
        if (
          typeof member === "object" &&
          "type" in member &&
          member.id === id
        ) {
          touched = true;
          const next = fn(member);
          if (next !== null) items.push(next);
          continue;
        }
        items.push(member);
      }
      out.push(touched ? { ...node, items } : node);
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * Stable render/addressing id for a node with no persisted `id` (hand-authored).
 * Used only as the React key + addressing handle until the first in-app write
 * assigns a real uuid. Stable across renders because it is derived purely from
 * the node's verbatim raw shape.
 */
export function fallbackNodeId(data: ReorderNodeData): string {
  return `__node:${data.type}:${JSON.stringify(data.rawNode)}`;
}

/**
 * An area's writes over its raw `items` tree and applied `state`, funnelled
 * through `setConfig("items", tree)` (the user config layer). The returned
 * object and every callback in it are stable: they read the latest tree/state
 * through refs when they FIRE, so a live-state push never churns the area
 * context or re-renders every item app-wide.
 */
export function useAreaWrites(
  items: ReorderTree,
  state: ReorderState,
  setConfig: (key: string, value: unknown) => void,
): ReorderAreaWrites {
  const entriesRef = useLatestRef(state.entries);
  // `itemsRef` feeds the verbatim raw-tree maps (remove/patch by id) — the same
  // tree `entriesRef` is derived from.
  const itemsRef = useLatestRef(items);
  const setConfigRef = useLatestRef(setConfig);

  return useMemo<ReorderAreaWrites>(() => {
    const commit = (tree: ReorderTree) => setConfigRef.current("items", tree);
    return {
      removeNode(id) {
        commit(mapNodeById(itemsRef.current, id, () => null));
      },

      // Addresses the node by `id`; a container without an `id` (hand-authored)
      // gets a lazily-assigned uuid in the same write. `renderId` is the
      // render-time fallback id used as the key when the node has no persisted
      // id; we resolve it back to the matching raw node positionally.
      patchNode(renderId, partial) {
        // Find the addressed node-data among top-level entries OR one level
        // inside a container, by persisted id first, else by positional fallback id.
        let target: ReorderNodeData | undefined;
        for (const e of entriesRef.current) {
          if (!isNodeData(e)) continue;
          if ((e.id ?? fallbackNodeId(e)) === renderId) {
            target = e;
            break;
          }
          for (const m of e.members ?? []) {
            if (isNodeData(m) && (m.id ?? fallbackNodeId(m)) === renderId) {
              target = m;
              break;
            }
          }
          if (target) break;
        }
        if (!target) return;

        // Persisted id → verbatim id-addressed map (top-level or one level deep).
        if (target.id) {
          commit(
            mapNodeById(itemsRef.current, target.id, (node) => {
              if (typeof node === "string" || "item" in node) return node;
              return { ...node, ...partial };
            }),
          );
          return;
        }

        // No persisted id (hand-authored): locate the rawNode by reference and
        // assign a lazy uuid in the same write. Containers are top-level only
        // (no-nesting), so an id-less header is always a top-level node.
        const rawTarget = target.rawNode;
        commit(
          itemsRef.current.map((node) =>
            node === rawTarget && typeof node === "object" && "type" in node
              ? { ...node, id: crypto.randomUUID(), ...partial }
              : node,
          ),
        );
      },
    };
  }, []);
}
