import {
  claimPending,
  claimed,
  declined,
  type CodeClaim,
} from "@plugins/active-data/web";
import { pluginIdSegments } from "@plugins/framework/plugins/plugin-id/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  pluginTree,
  type PluginNode,
  type PluginTreePayload,
} from "@plugins/plugin-meta/plugins/plugin-view/core";

interface PluginIndex {
  byId: Map<string, PluginNode>;
  bySegment: Map<string, PluginNode[]>;
}

function indexNodes(
  nodes: PluginNode[],
  index: PluginIndex = { byId: new Map(), bySegment: new Map() },
): PluginIndex {
  for (const node of nodes) {
    index.byId.set(node.id, node);
    const seg = pluginIdSegments(node.id).pop()!;
    const arr = index.bySegment.get(seg);
    if (arr) arr.push(node);
    else index.bySegment.set(seg, [node]);
    indexNodes(node.children, index);
  }
  return index;
}

// The tree walk is O(all plugins) and the payload is one immutable live value
// shared by every chip on the surface — so index it ONCE per payload identity
// rather than once per chip. A WeakMap keyed on the payload keeps this free of
// manual invalidation: a new payload (the server's `plugins/` watcher moved the
// tree) is a new key, and the old index is collected with the old payload.
const INDEX_BY_PAYLOAD = new WeakMap<PluginTreePayload, PluginIndex>();

function indexFor(payload: PluginTreePayload): PluginIndex {
  const cached = INDEX_BY_PAYLOAD.get(payload);
  if (cached) return cached;
  const index = indexNodes(payload.plugins);
  INDEX_BY_PAYLOAD.set(payload, index);
  return index;
}

/**
 * The semantic gate for `` `some-plugin-id` ``: resolve the backticked token
 * against the live plugin tree.
 *
 * A failed tree read is a SETTLED decline, not `pending`: pending stops the
 * arbitration chain (by design — see `CodeClaim`), so treating a failed tree read as
 * pending would let plugin-link block every other code contribution on the token
 * forever. "I cannot answer, move on" is the honest claim.
 */
export function usePluginClaim(text: string): CodeClaim<PluginNode> {
  const id = text.trim();
  const tree = useLive(pluginTree);

  if (tree.status === "loading") return claimPending();
  if (tree.status === "error") return declined("plugin tree unavailable");

  const index = indexFor(tree.data);
  const exact = index.byId.get(id);
  if (exact) return claimed(exact);
  // Fuzzy: if the input matches exactly one plugin's last segment, use it.
  const bySegment = index.bySegment.get(id);
  if (bySegment?.length === 1) return claimed(bySegment[0]!);
  return declined(
    bySegment === undefined
      ? `no plugin with id or leaf name "${id}"`
      : `"${id}" is the leaf name of ${bySegment.length} plugins — ambiguous`,
  );
}
