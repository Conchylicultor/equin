import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginsDirWatcher } from "./internal/structure-tree-cache";
import { pluginTreeWarmup } from "./internal/warmup";

export {
  getStructureTreeCached,
  getFacetsTreeCached,
  onPluginTreeChanged,
  pluginTreeGeneration,
} from "./internal/structure-tree-cache";

export default {
  description:
    "Cached, watcher-invalidated plugin-tree accessors: structure-only for the hot path and a shared full-faceted build for the two facet consumers.",
  register: [pluginTreeWarmup, pluginsDirWatcher],
} satisfies ServerPluginDefinition;
