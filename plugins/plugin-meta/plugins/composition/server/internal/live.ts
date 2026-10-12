import {
  classifyEdges,
  serializeEdgeGraph,
} from "@plugins/plugin-meta/plugins/closure/core";
import {
  getFacetsTreeCached,
  onPluginTreeChanged,
  pluginTreeGeneration,
} from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  compositionData,
  type CompositionData,
} from "@plugins/plugin-meta/plugins/composition/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";

// The expensive part is the facets tree build, which plugin-tree already caches
// (watcher-invalidated, warmed post-boot on main). The derivations on top of it
// are cheap (~10ms measured: classify 8ms + serialize 1ms + one id scan), so
// they are memoized per tree IDENTITY: when plugin-tree's memo rebuilds, the new
// tree object misses the WeakMap and the graph is re-derived. This replaces the
// old process-lifetime module cache, which never invalidated — after any live
// plugin change it kept serving the boot-time graph forever (the staleness
// follow-up noted in this plugin's CLAUDE.md).
const derived = new WeakMap<PluginTree, CompositionData>();

function deriveCompositionData(tree: PluginTree): CompositionData {
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
// `plugins/`: told of a change by plugin-tree's watcher (`onPluginTreeChanged`)
// while a tab holds it, and ETagged by the same generation the tree's memo
// rebuilds on, so an unchanged tree answers 304. Throttled like the faceted
// tree itself: each re-read rebuilds every facet.
export const compositionDataServed = serveValue(compositionData, {
  source: "external",
  changes: "notified",
  loader: async () => deriveCompositionData(await getFacetsTreeCached()),
  revalidate: () => pluginTreeGeneration(),
  whileSubscribed: (_params, notify) => onPluginTreeChanged(notify),
  throttleMs: 2_000,
});
