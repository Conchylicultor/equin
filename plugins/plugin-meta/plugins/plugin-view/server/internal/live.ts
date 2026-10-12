import {
  getFacetsTreeCached,
  getStructureTreeCached,
  onPluginTreeChanged,
  pluginTreeGeneration,
} from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { pluginFacetsTree, pluginTree } from "../../core/values";
import { treeToPayload } from "./to-payload";

// Both trees live on disk under `plugins/`, so they are external values told of
// a change by plugin-tree's one `plugins/` watcher (`onPluginTreeChanged`) for
// as long as a tab holds them. Each read is ETagged by the watcher's generation
// (`pluginTreeGeneration`), the same token plugin-tree's memos rebuild on: a tab
// asked to read again after a change that left the tree alone still re-reads,
// but an unchanged generation answers 304 without shipping the payload.
// Exclusion from the app is derived client-side, from the composition edge
// graph — neither payload carries a membership field.

/**
 * Structure-only + cached: the hot path never reads facets (no facet
 * extract/relate, no barrel import). Throttled like the faceted values: every
 * code span in an open conversation subscribes it, and a build or a burst of
 * saves moves the generation once per watcher batch, so each subscribed tab
 * re-reads the ~1.4k-node payload at most every 2 s rather than once per batch.
 */
export const pluginTreeServed = serveValue(pluginTree, {
  source: "external",
  changes: "notified",
  loader: async () => treeToPayload(await getStructureTreeCached()),
  revalidate: () => pluginTreeGeneration(),
  whileSubscribed: (_params, notify) => onPluginTreeChanged(notify),
  throttleMs: 2_000,
});

/**
 * The full faceted tree, from plugin-tree's shared faceted build. Throttled:
 * every edit under `plugins/` moves the generation, and each re-read rebuilds
 * every facet, so an agent saving files in a burst re-reads at most every 2 s.
 */
export const pluginFacetsTreeServed = serveValue(pluginFacetsTree, {
  source: "external",
  changes: "notified",
  loader: async () => treeToPayload(await getFacetsTreeCached()),
  revalidate: () => pluginTreeGeneration(),
  whileSubscribed: (_params, notify) => onPluginTreeChanged(notify),
  throttleMs: 2_000,
});
