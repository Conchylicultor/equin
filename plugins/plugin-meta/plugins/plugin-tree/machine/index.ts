import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { FacetedTreeSource } from "@plugins/plugin-meta/plugins/plugin-tree/server";
import {
  facetedTreeDaemon,
  openFacetedTreeSession,
} from "./internal/faceted-tree-source";

export default {
  description:
    "Plugin tree, desktop-only half: provides the FacetedTreeSource host service as a worker thread (bin/faceted-tree-worker.ts, the plugin-tree.faceted-index daemon) holding this checkout's faceted index (plugin-tree/faceted) and the structure tree it builds first (posted ahead of the facets) — built once per process from the last worker's checkpoint, then refreshed by the watcher's paths — so neither tree is built in the serving backend.",
  register: [facetedTreeDaemon],
  contributions: [FacetedTreeSource.provide({ open: openFacetedTreeSession })],
} satisfies MachinePluginDefinition;
