import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginsDirWatcher } from "./internal/structure-tree-cache";
import { pluginTreeWarmup } from "./internal/warmup";

export {
  getStructureTreeCached,
  getFacetsTreeCached,
  onPluginStructureChanged,
  onPluginTreeChanged,
  pluginStructureGeneration,
  pluginTreeGeneration,
} from "./internal/structure-tree-cache";
export { FacetedTreeSource } from "./internal/faceted-source";
export type { FacetedTreeSourceImpl } from "./internal/faceted-source";

export default {
  description:
    "Watcher-kept plugin-tree accessors: the structure tree, kept up to date in-process by what changed (a plugin added or removed, a key file edited — O(changes), with its own change signal), and the faceted tree, read as data through the FacetedTreeSource host service (never extracted in the backend).",
  register: [pluginTreeWarmup, pluginsDirWatcher],
} satisfies ServerPluginDefinition;
