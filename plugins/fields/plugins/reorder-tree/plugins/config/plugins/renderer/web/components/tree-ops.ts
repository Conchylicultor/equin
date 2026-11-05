import type {
  ReorderNode,
  ReorderTree,
} from "@plugins/fields/plugins/reorder-tree/core";
import {
  normalizeNode,
  type NormalizedNode,
} from "@plugins/fields/plugins/reorder-tree/plugins/config/core";

// Pure `ReorderTree` ↔ view transforms for the settings-pane drag editor. The
// settings pane has no live contribution catalog, so the view is built purely
// from the saved tree (entryKey strings) — no `applyTree`, no drift. Node types
// (spacer, header, …) are rendered through the registry by the consumer; these
// helpers stay registry-agnostic and only know the structural tree shape.

/**
 * A top-level view entry. Item entries carry an `entryKey` string; node entries
 * carry the structural type/id/payload plus (for containers) their members. The
 * config pane has no live catalog, so container members are the same loose
 * item view entries (no recursion into nested containers — none allowed).
 *
 * `viewId` is the stable address the consumer threads back into `patchNode` /
 * `removeNode`. It is the node's real structural `id` when present, else a
 * positional `NODE_VIEW_ID_PREFIX + index` fallback that `patchNode` resolves to
 * the exact tree position (assigning a lazy uuid on first write).
 */
export type ReorderViewEntry =
  | { kind: "item"; id: string }
  | {
      kind: "node";
      type: string;
      id?: string;
      viewId: string;
      payload: Record<string, unknown>;
      members?: ReorderItemView[];
    };

/** A container member: only loose items in this pass (no nested containers). */
export type ReorderItemView = { kind: "item"; id: string };

/** Positional fallback prefix for an id-less node's `viewId`. */
const NODE_VIEW_ID_PREFIX = "__reorder-node-idx:";

/** Ordered visible entries + the hidden bucket, derived from the saved tree. */
export function treeToView(tree: ReorderTree): {
  entries: ReorderViewEntry[];
  hiddenItems: Array<{ key: string; label: string }>;
} {
  const entries: ReorderViewEntry[] = [];
  const hiddenItems: Array<{ key: string; label: string }> = [];
  const seenNodeIds = new Set<string>();
  tree.forEach((node, index) => {
    const n = normalizeNode(node);
    if (n.kind === "item") {
      if (n.hidden) {
        hiddenItems.push({ key: n.item, label: n.item });
        return;
      }
      entries.push({ kind: "item", id: n.item });
      return;
    }
    // Node (spacer / container / other leaf). Dedup by id when present —
    // there's no `applyTree` here, and duplicate sortable ids break dnd.
    if (n.id !== undefined) {
      if (seenNodeIds.has(n.id)) return;
      seenNodeIds.add(n.id);
    }
    const members =
      n.members === undefined ? undefined : membersToView(n.members);
    entries.push({
      kind: "node",
      type: n.type,
      id: n.id,
      viewId: n.id ?? `${NODE_VIEW_ID_PREFIX}${index}`,
      payload: n.payload,
      members,
    });
  });
  return { entries, hiddenItems };
}

/** Map a container's raw members to loose item views (skip non-items). */
function membersToView(members: ReorderNode[]): ReorderItemView[] {
  const out: ReorderItemView[] = [];
  for (const m of members) {
    const n = normalizeNode(m);
    if (n.kind === "item" && !n.hidden) out.push({ kind: "item", id: n.item });
  }
  return out;
}

/**
 * Re-emit a normalized node as a `ReorderNode`, VERBATIM-preserving container
 * subtrees (members/payload kept intact). Items collapse to the terse bare
 * string (or `{item,hidden:true}`).
 */
function serialize(n: NormalizedNode): ReorderNode {
  if (n.kind === "item") {
    return n.hidden ? { item: n.item, hidden: true } : n.item;
  }
  // Node: re-emit structural `type`/`id`/`items` + payload verbatim.
  const out: { type: string; id?: string; items?: ReorderNode[] } & Record<
    string,
    unknown
  > = { type: n.type, ...n.payload };
  if (n.id !== undefined) out.id = n.id;
  if (n.members !== undefined) out.items = n.members;
  return out;
}

function nodeId(n: NormalizedNode): string | null {
  if (n.kind === "item") return n.item;
  return n.id ?? null;
}

/** A top-level loose item (visible) or a leaf node (e.g. spacer) — draggable. */
function isLoose(n: NormalizedNode): boolean {
  if (n.kind === "item") return !n.hidden;
  // Container nodes (with members) are NOT top-level draggable; leaf nodes are.
  return n.members === undefined;
}

/**
 * Move `draggedId` to `overId`'s slot within the loose top-level order (items +
 * leaf nodes such as spacers). Hidden items are appended last so a reorder never
 * un-hides. Container nodes are preserved at their original positions (they are
 * not draggable in this pass).
 */
export function reorderTree(
  tree: ReorderTree,
  draggedId: string,
  overId: string,
): ReorderTree {
  const norm = tree.map(normalizeNode);
  // Split into three streams. Containers are anchored by their position WITHIN
  // the visible (non-hidden) subsequence — hidden items are pulled out first so
  // their count can't shift a container's anchor. Loose nodes reflow around the
  // anchored containers.
  const containerSlots: Array<{ pos: number; node: NormalizedNode }> = [];
  const loose: NormalizedNode[] = [];
  const hidden: NormalizedNode[] = [];
  let visiblePos = 0;
  for (const n of norm) {
    if (n.kind === "item" && n.hidden) {
      hidden.push(n);
    } else if (isLoose(n)) {
      loose.push(n);
      visiblePos++;
    } else {
      containerSlots.push({ pos: visiblePos, node: n });
      visiblePos++;
    }
  }

  const from = loose.findIndex((n) => nodeId(n) === draggedId);
  const to = loose.findIndex((n) => nodeId(n) === overId);
  if (from < 0 || to < 0 || from === to) return tree;

  const [moved] = loose.splice(from, 1);
  loose.splice(to, 0, moved!);

  // Rebuild the visible subsequence: re-insert containers at their anchored
  // positions, fill the gaps with the reordered loose nodes, then append hidden
  // items last so a reorder never un-hides.
  const result: NormalizedNode[] = [];
  let looseIdx = 0;
  const total = containerSlots.length + loose.length;
  for (let i = 0; i < total; i++) {
    const container = containerSlots.find((c) => c.pos === i);
    if (container) result.push(container.node);
    else result.push(loose[looseIdx++]!);
  }
  return [...result, ...hidden].map(serialize);
}

/** Flip a visible item to `{ item, hidden: true }` in place. */
export function hideInTree(tree: ReorderTree, key: string): ReorderTree {
  return tree.map((node) => {
    const n = normalizeNode(node);
    return n.kind === "item" && !n.hidden && n.item === key
      ? { item: key, hidden: true }
      : node;
  });
}

/**
 * Flip a hidden item back to a bare string, in place. (The field editor has no
 * natural-order catalog to re-append to — a harmless divergence from the
 * middleware, which restores to the end.)
 */
export function restoreInTree(tree: ReorderTree, key: string): ReorderTree {
  return tree.map((node) => {
    const n = normalizeNode(node);
    return n.kind === "item" && n.hidden && n.item === key ? key : node;
  });
}

/**
 * Resolve a `viewId` (from {@link treeToView}) to a tree index. A real
 * structural id matches the node carrying it; a positional fallback matches its
 * encoded index. Returns -1 when nothing matches.
 */
function resolveViewId(norm: NormalizedNode[], viewId: string): number {
  if (viewId.startsWith(NODE_VIEW_ID_PREFIX)) {
    const index = Number(viewId.slice(NODE_VIEW_ID_PREFIX.length));
    const n = norm[index];
    return n !== undefined && n.kind === "node" && n.id === undefined
      ? index
      : -1;
  }
  return norm.findIndex((n) => n.kind === "node" && n.id === viewId);
}

/** Remove a node (e.g. spacer, container) addressed by its `viewId`. */
export function removeNode(tree: ReorderTree, viewId: string): ReorderTree {
  const norm = tree.map(normalizeNode);
  const target = resolveViewId(norm, viewId);
  if (target < 0) return tree;
  return tree.filter((_, i) => i !== target);
}

/**
 * Shallow-merge `partial` into the addressed node's payload (e.g. a header's
 * collapse toggle). A container lacking an `id` gets a lazily-assigned uuid the
 * first time it is patched (mirrors the spacer uuid-on-create pattern).
 */
export function patchNode(
  tree: ReorderTree,
  viewId: string,
  partial: Record<string, unknown>,
): ReorderTree {
  const norm = tree.map(normalizeNode);
  const target = resolveViewId(norm, viewId);
  if (target < 0) return tree;
  return norm.map((n, i) => {
    if (i !== target || n.kind !== "node") return tree[i]!;
    return serialize({
      ...n,
      id: n.id ?? crypto.randomUUID(),
      payload: { ...n.payload, ...partial },
    });
  });
}

/** Append a `ReorderNode` (used by registry `insert.create()`). */
export function insertNode(tree: ReorderTree, node: ReorderNode): ReorderTree {
  return [...tree, node];
}
