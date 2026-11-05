import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { FacetedTreeSource } from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { readFacetedTree } from "./internal/read-faceted-tree";

export default {
  description:
    "Plugin tree, desktop-only half: provides the FacetedTreeSource host service by running ./equin plugin-tree-facets in this checkout and parsing the JSON it writes, so the facet extractors never run in the serving backend.",
  contributions: [FacetedTreeSource.provide({ read: readFacetedTree })],
} satisfies MachinePluginDefinition;
