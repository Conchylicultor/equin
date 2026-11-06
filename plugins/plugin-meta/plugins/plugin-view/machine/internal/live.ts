import {
  getFacetsTreeCached,
  getStructureTreeCached,
  onPluginFacetsChanged,
  onPluginStructureChanged,
  pluginFacetsGeneration,
  pluginStructureGeneration,
} from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { pluginFacetsTree, pluginTree } from "../../core/values";
import { treeToPayload } from "./to-payload";

// Both trees live on disk under `plugins/`, so they are external values told of
// a change by plugin-tree (each tree has its own signal, moved only when that
// tree changed) for as long as a tab holds them. Each read is ETagged by that
// tree's generation, so an unchanged generation answers 304 without shipping
// the payload.
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
 * The full faceted tree, kept up to date by plugin-tree from what changed. Told
 * of FACETED changes only (`onPluginFacetsChanged`: an edit that moved what a
 * facet extracts, a plugin added or removed) — a save the facets do not see
 * never reaches the tabs — so no throttle stands between a change and them.
 */
export const pluginFacetsTreeServed = serveValue(pluginFacetsTree, {
  source: "external",
  changes: "notified",
  loader: async () => treeToPayload(await getFacetsTreeCached()),
  revalidate: () => pluginFacetsGeneration(),
  whileSubscribed: (_params, notify) => onPluginFacetsChanged(notify),
});
