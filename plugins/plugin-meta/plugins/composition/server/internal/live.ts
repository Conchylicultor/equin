import {
  classifyEdges,
  serializeEdgeGraph,
} from "@plugins/plugin-meta/plugins/closure/core";
import {
  getFacetsTreeCached,
  onPluginFacetsChanged,
  pluginFacetsGeneration,
} from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  compositionData,
  type CompositionData,
} from "@plugins/plugin-meta/plugins/composition/core";
import type { PluginTreeData } from "@plugins/plugin-meta/plugins/plugin-tree/core";

// The expensive part is the facets tree, which plugin-tree keeps up to date by
// what changed (warmed post-boot on main). The derivations on top of it
// are cheap (~10ms measured: classify 8ms + serialize 1ms + one id scan), so
// they are memoized per tree IDENTITY: when plugin-tree's tree changes, the new
// tree object misses the WeakMap and the graph is re-derived. This replaces the
// old process-lifetime module cache, which never invalidated — after any live
// plugin change it kept serving the boot-time graph forever (the staleness
// follow-up noted in this plugin's CLAUDE.md).
const derived = new WeakMap<PluginTreeData, CompositionData>();

function deriveCompositionData(tree: PluginTreeData): CompositionData {
  const hit = derived.get(tree);
  if (hit) return hit;
  const edgeGraph = classifyEdges(tree);
  const graph = serializeEdgeGraph(edgeGraph);
  const allIds = [...tree.byDir.values()].map((n) => n.id);
  // Only the code-derived structure ships. Which plugins are OUT of the app is
  // not a second field here: it is a pure function of this graph and the
  // composition manifests, and the client already holds both — see
  // `useAppExclusions` (web/internal/hooks.ts).
  const data = { graph, allIds };
  derived.set(tree, data);
  return data;
}

// Manifests are not served here — they are user data stored in the
// `compositions` config_v2 config and read client-side. This value carries only
// the code-derived graph structure, so its one input is the faceted tree of
// `plugins/`: told of a change of it (`onPluginFacetsChanged`) while a tab
// holds it, and ETagged by its generation, so an unchanged tree answers 304.
// No throttle: the signal moves only when the faceted tree did, and a re-read
// costs the derivation above, not a facet build.
export const compositionDataServed = serveValue(compositionData, {
  source: "external",
  changes: "notified",
  loader: async () => deriveCompositionData(await getFacetsTreeCached()),
  revalidate: () => pluginFacetsGeneration(),
  whileSubscribed: (_params, notify) => onPluginFacetsChanged(notify),
});
