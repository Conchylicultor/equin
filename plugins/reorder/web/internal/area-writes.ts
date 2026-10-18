import { useMemo } from "react";
import type {
  ReorderNode,
  ReorderTree,
} from "@plugins/fields/plugins/reorder-tree/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { ReorderAreaWrites } from "./editor-contract";
import {
  contributionKey,
  entryKey,
  isNodeData,
  type ReorderNodeData,
  type ReorderState,
  type TopLevelEntry,
} from "./sorting";

// The write half of an area. It lives with the apply side, not the editor,
// because one write is live at rest: a header's collapse toggle (`patchNode`).
// The editor receives these through `ReorderAreaEditorProps.writes`.

/**
 * Serialize one top-level entry to a `ReorderNode`:
 *  - a live `Contribution` → its bare `entryKey` string (terse item);
 *  - a node (`ReorderNodeData`) → its `rawNode` VERBATIM (a container rides
 *    along with its members/payload unchanged; a leaf node keeps its `id`/payload).
 */
function entryToNode(entry: TopLevelEntry): ReorderNode {
  return isNodeData(entry) ? entry.rawNode : entryKey(entry);
}

/**
 * Materialize the current top-level order into a fresh `ReorderTree`:
 * contributions become bare strings, node entries re-emit their raw subtree
 * verbatim, and the hidden set is appended last as `{ item, hidden: true }`
 * nodes so a reorder/insert write never un-hides. Containers ride along at
 * their array positions (they are not top-level draggable).
 *
 * `hideKey`/`restoreKey` flip a single contribution to/from hidden.
 */
function materializeTree(
  entries: TopLevelEntry[],
  hiddenKeys: string[],
  opts?: { hideKey?: string; restoreKey?: string },
): ReorderTree {
  const tree: ReorderNode[] = [];
  for (const e of entries) {
    if (!isNodeData(e)) {
      const key = entryKey(e);
      if (key === opts?.hideKey) {
        tree.push({ item: key, hidden: true });
        continue;
      }
    }
    tree.push(entryToNode(e));
  }
  for (const key of hiddenKeys) {
    if (key === opts?.hideKey) continue;
    if (key === opts?.restoreKey) {
      tree.push(key);
    } else {
      tree.push({ item: key, hidden: true });
    }
  }
  return tree;
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
  const hiddenKeysRef = useLatestRef(
    useMemo(() => state.hidden.map((c) => contributionKey(c)!), [state.hidden]),
  );
  const setConfigRef = useLatestRef(setConfig);

  return useMemo<ReorderAreaWrites>(() => {
    const commit = (tree: ReorderTree) => setConfigRef.current("items", tree);
    return {
      hide(key) {
        if (hiddenKeysRef.current.includes(key)) return;
        commit(
          materializeTree(entriesRef.current, hiddenKeysRef.current, {
            hideKey: key,
          }),
        );
      },

      restore(key) {
        if (!hiddenKeysRef.current.includes(key)) return;
        commit(
          materializeTree(entriesRef.current, hiddenKeysRef.current, {
            restoreKey: key,
          }),
        );
      },

      drop(draggedKey, overKey) {
        if (draggedKey === overKey) return;
        const list = entriesRef.current;

        const idOf = (e: TopLevelEntry): string =>
          isNodeData(e) ? (e.id ?? "") : entryKey(e);
        const excludedOf = (e: TopLevelEntry): boolean =>
          !isNodeData(e) && !!(e as Record<string, unknown>).excludeFromReorder;

        const dragged = list.find((x) => idOf(x) === draggedKey);
        const target = list.find((x) => idOf(x) === overKey);
        if (!dragged || !target) return;
        // Containers are not top-level draggable; only items move.
        if (isNodeData(dragged) && dragged.members) return;
        if (excludedOf(dragged) || excludedOf(target)) return;

        // Reorder over the non-excluded slice, then materialize the full order.
        const reorderable = list.filter((x) => !excludedOf(x));
        const fromIdx = reorderable.findIndex((x) => idOf(x) === draggedKey);
        const toIdx = reorderable.findIndex((x) => idOf(x) === overKey);
        if (fromIdx < 0 || toIdx < 0) return;

        const next = reorderable.slice();
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved!);

        // Re-append the excluded tail (pinned last) so it isn't dropped.
        const tail = list.filter((x) => excludedOf(x));
        commit(materializeTree([...next, ...tail], hiddenKeysRef.current));
      },

      insert(create) {
        const tree = materializeTree(entriesRef.current, hiddenKeysRef.current);
        tree.push(create());
        commit(tree);
      },

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
