import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginsDirWatcher } from "./internal/structure-tree-cache";
import { pluginTreeWarmup } from "./internal/warmup";

export {
  getStructureTreeCached,
  getFacetsTreeCached,
  onPluginFacetsChanged,
  onPluginStructureChanged,
  pluginFacetsGeneration,
  pluginStructureGeneration,
} from "./internal/structure-tree-cache";
export {
  FacetedSessionEnded,
  FacetedTreeSource,
} from "./internal/faceted-source";
export type {
  FacetedTreeSession,
  FacetedTreeSourceImpl,
} from "./internal/faceted-source";

export default {
  description:
    "Watcher-kept plugin-tree accessors: the structure tree, kept up to date in-process by what changed (a plugin added or removed, a key file edited — O(changes), with its own change signal), and the faceted tree, kept up to date by what changed through the FacetedTreeSource host service (a worker holding the faceted index, never extracted in the backend), with its own change signal.",
  register: [pluginTreeWarmup, pluginsDirWatcher],
} satisfies ServerPluginDefinition;
