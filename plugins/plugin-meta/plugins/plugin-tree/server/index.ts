import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginsDirWatcher } from "./internal/structure-tree-cache";
import { pluginTreeWarmup } from "./internal/warmup";

export {
  getStructureTreeCached,
  getFacetsTreeCached,
  onPluginTreeChanged,
  pluginTreeGeneration,
} from "./internal/structure-tree-cache";
export { FacetedTreeSource } from "./internal/faceted-source";
export type { FacetedTreeSourceImpl } from "./internal/faceted-source";

export default {
  description:
    "Cached, watcher-invalidated plugin-tree accessors: the structure tree, built in-process for the hot path, and the faceted tree, read as data through the FacetedTreeSource host service (never extracted in the backend).",
  register: [pluginTreeWarmup, pluginsDirWatcher],
} satisfies ServerPluginDefinition;
