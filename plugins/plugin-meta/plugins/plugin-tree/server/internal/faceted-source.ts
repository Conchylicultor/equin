import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { PluginTreeData } from "@plugins/plugin-meta/plugins/plugin-tree/core";

/**
 * Where this host's faceted plugin tree comes from. Building it runs every
 * facet extractor — build tooling, loaded by a computed path — which never
 * runs in a serving backend (`boot:closure-digestable`), so the tree is read
 * as data: the desktop's provider (`plugin-tree#machine`) runs
 * `./equin plugin-tree-facets` in this checkout and parses what it wrote.
 */
export interface FacetedTreeSourceImpl {
  /** The faceted tree, read now. A failed read throws — never a partial tree. */
  read(): Promise<PluginTreeData>;
}

export const FacetedTreeSource = defineHostService<FacetedTreeSourceImpl>(
  "plugin-tree.faceted-source",
);
