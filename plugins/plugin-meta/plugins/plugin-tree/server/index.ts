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
  FacetsUnavailable,
} from "./internal/faceted-source";
export type {
  FacetedSessionHandlers,
  FacetedTreeSession,
  FacetedTreeSourceImpl,
} from "./internal/faceted-source";

export default {
  description:
    "Watcher-kept plugin-tree accessors: the structure tree and the faceted tree, both held by the FacetedTreeSource host service (a worker holding the faceted index, which builds the structure first and hands it out ahead of the facets — neither is built in the backend), kept up to date by what changed (O(changes)), each with its own change signal.",
  register: [pluginTreeWarmup, pluginsDirWatcher],
} satisfies ServerPluginDefinition;
