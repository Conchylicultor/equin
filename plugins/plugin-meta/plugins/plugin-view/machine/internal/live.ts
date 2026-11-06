import {
  getFacetsTreeCached,
  getStructureTreeCached,
  onPluginStructureChanged,
  onPluginTreeChanged,
  pluginStructureGeneration,
  pluginTreeGeneration,
} from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
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
 * Structure-only: the hot path never reads facets (no facet extract/relate, no
 * barrel import). Told of STRUCTURE changes only (`onPluginStructureChanged`:
 * a plugin added or removed, a barrel or package.json edited) — an edit to any
 * other file under `plugins/` never reaches the tabs holding it — and the tree
 * it reads is kept up to date by what changed, so no throttle stands between a
 * change and the tabs.
 */
export const pluginTreeServed = serveValue(pluginTree, {
  source: "external",
  changes: "notified",
  loader: async () => treeToPayload(await getStructureTreeCached()),
  revalidate: () => pluginStructureGeneration(),
  whileSubscribed: (_params, notify) => onPluginStructureChanged(notify),
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
