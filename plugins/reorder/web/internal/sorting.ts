import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type {
  ReorderNode,
  ReorderTree,
} from "@plugins/fields/plugins/reorder-tree/core";
import { normalizeNode } from "@plugins/fields/plugins/reorder-tree/plugins/config/core";

/**
 * A registry-agnostic node entry emitted by {@link applyTree}: the structured,
 * payload-opaque projection of a `{ type, id?, items? }` node over the live
 * catalog. The registry (`useReorderNodeTypes`) interprets `type`/`payload`
 * downstream — `applyTree` stays free of node-type knowledge.
 *
 * `members` is present only for CONTAINER nodes (a node with an `items` list);
 * each member is resolved against the live catalog (and CONSUMED so it isn't
 * re-emitted at top level). `rawNode` is the ORIGINAL `ReorderNode` captured
 * verbatim, so the write path can re-emit container subtrees unchanged.
 */
export interface ReorderNodeData {
  readonly _node: true;
  readonly type: string;
  readonly id?: string;
  readonly payload: Record<string, unknown>;
  readonly members?: (Contribution | ReorderNodeData)[];
  readonly rawNode: ReorderNode;
}

export type TopLevelEntry = Contribution | ReorderNodeData;

export function isNodeData(entry: TopLevelEntry): entry is ReorderNodeData {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime discriminant; TS narrows through the cast
  return (entry as ReorderNodeData)._node === true;
}

export interface ReorderState {
  entries: TopLevelEntry[];
  hidden: Contribution[];
}

export function contributionKey(c: Contribution): string | null {
  const id = c.id as string | undefined;
  if (!id) return null;
  return c._pluginId ? `${c._pluginId}:${id}` : id;
}

export function entryKey(c: Contribution): string {
  const id = (c.id as string | undefined) ?? "";
  return c._pluginId ? `${c._pluginId}:${id}` : id;
}

export function contributionLabel(c: Contribution): string {
  // Prefer the short, stable `id` (e.g. `allow-monitor`) over the full dotted
  // `_pluginId` path (`conversations.conversation-view.allow-monitor`) — the
  // empty-item placeholder is a compact drag affordance, not a debug label, so
  // the long path overflows narrow horizontal bands.
  return (
    (c.id as string | undefined) ??
    (c._pluginId as string | undefined) ??
    "Item"
  );
}

function isExcluded(c: Contribution): boolean {
  return !!(c as Record<string, unknown>).excludeFromReorder;
}

/**
 * Apply a reorder `ReorderTree` over the LIVE contribution catalog.
 *
 * A positional WALK of the tree (via `normalizeNode`) that emits structured
 * top-level entries — live `Contribution`s and `ReorderNodeData` projections of
 * `{ type }` nodes:
 *  - `kind:"item"` hidden → route the matching live contribution to `hidden`
 *    (but `excludeFromReorder` items are NEVER hidden).
 *  - `kind:"item"` visible → resolve against the `byKey` map and CONSUME it.
 *    A token matching no live contribution (drift) is skipped.
 *  - `kind:"node"` with `members` (container) → resolve EACH member against
 *    `byKey`, CONSUMING them (so the tail-append doesn't re-emit them at top
 *    level). Any member that is itself a container is ignored (no-nesting
 *    policy). Emit a `ReorderNodeData` carrying the original node verbatim.
 *  - `kind:"node"` without `members` (leaf, e.g. spacer) → emit a leaf
 *    `ReorderNodeData`.
 *
 * After the walk, any live visible-non-excluded contribution NOT named in the
 * tree is appended in natural runtime order (fail-loud — never silently
 * dropped). `excludeFromReorder` items stay pinned last, never hidden.
 */
export function applyTree(
  contributions: readonly Contribution[],
  tree: ReorderTree,
): ReorderState {
  // First pass: collect the entryKeys explicitly marked hidden (top level OR
  // inside a container), so the catalog partition can route them up front.
  const hiddenSet = new Set<string>();
  const collectHidden = (nodes: ReorderTree) => {
    for (const node of nodes) {
      const n = normalizeNode(node);
      if (n.kind === "item") {
        if (n.hidden) hiddenSet.add(n.item);
      } else if (n.members) {
        collectHidden(n.members);
      }
    }
  };
  collectHidden(tree);

  // Partition the live catalog into hidden / visible-non-excluded / excluded.
  const hidden: Contribution[] = [];
  const visible: Contribution[] = [];
  const excluded: Contribution[] = [];

  for (const c of contributions) {
    const key = contributionKey(c);
    if (!key) continue;
    if (isExcluded(c)) {
      excluded.push(c);
    } else if (hiddenSet.has(key)) {
      hidden.push(c);
    } else {
      visible.push(c);
    }
  }

  // Index visible-non-excluded by entryKey; entries are deleted as consumed.
  const byKey = new Map<string, Contribution>();
  for (const c of visible) {
    byKey.set(contributionKey(c)!, c);
  }

  const entries: TopLevelEntry[] = [];

  for (const node of tree) {
    const n = normalizeNode(node);
    if (n.kind === "item") {
      if (n.hidden) continue; // already routed to `hidden`
      if (byKey.has(n.item)) {
        entries.push(byKey.get(n.item)!);
        byKey.delete(n.item);
      }
      // else: drift (removed/unknown contribution) → skip.
      continue;
    }
    // kind:"node"
    if (n.members) {
      // Container: resolve + consume members (one level only).
      const members: (Contribution | ReorderNodeData)[] = [];
      for (const memberNode of n.members) {
        const m = normalizeNode(memberNode);
        if (m.kind === "item") {
          if (m.hidden) continue;
          if (byKey.has(m.item)) {
            members.push(byKey.get(m.item)!);
            byKey.delete(m.item);
          }
        } else if (m.members) {
          // Nested container → ignored (no-nesting policy).
          continue;
        } else {
          // Leaf node member (e.g. a spacer inside a container).
          members.push({
            _node: true,
            type: m.type,
            id: m.id,
            payload: m.payload,
            rawNode: memberNode,
          });
        }
      }
      entries.push({
        _node: true,
        type: n.type,
        id: n.id,
        payload: n.payload,
        members,
        rawNode: node,
      });
    } else {
      // Leaf node (e.g. spacer) at top level.
      entries.push({
        _node: true,
        type: n.type,
        id: n.id,
        payload: n.payload,
        rawNode: node,
      });
    }
  }

  // Append unconsumed visible-non-excluded in natural runtime order.
  for (const c of visible) {
    if (byKey.has(contributionKey(c)!)) entries.push(c);
  }

  // Excluded items pinned last, in natural order.
  for (const c of excluded) {
    entries.push(c);
  }

  return { entries, hidden };
}
