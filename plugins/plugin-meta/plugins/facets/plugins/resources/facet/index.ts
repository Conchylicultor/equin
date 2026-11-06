import {
  createFacet,
  getFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  resolvePluginSpecifier,
  type PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  resourceModeLabel,
  type ResourceFacetData,
  resourcesFacetDef,
} from "../core";
import { parseResources, resolveDeferredCalls } from "./parse-resources";

export default createFacet<ResourceFacetData>({
  def: resourcesFacetDef,

  extract(ctx) {
    return parseResources(ctx.dir, ctx.relDir);
  },

  // A descriptor imported from another plugin's barrel is resolved here, where
  // every plugin's data is in hand (see `parseResources`).
  relate(rawCtx) {
    const { tree } = rawCtx as { tree: PluginTree };
    const plugins = [...tree.byDir.values()].flatMap((node) => {
      const data = getFacet(node, resourcesFacetDef);
      return data ? [data] : [];
    });
    resolveDeferredCalls(plugins, (specifier) => {
      // `@plugins/<plugin path>/<runtime>` — a barrel, one segment past the plugin.
      const hit = resolvePluginSpecifier(tree, specifier);
      return hit?.suffix.length === 1
        ? (getFacet(hit.node, resourcesFacetDef) ?? null)
        : null;
    });
  },

  renderDoc(data) {
    const facts: DocFact[] = [];
    if (data.server.length > 0) {
      facts.push({
        folder: "server",
        key: "Resources",
        values: data.server.map(
          (r) => `\`${r.key}\` (${resourceModeLabel(r)})`,
        ),
      });
    }
    if (data.central.length > 0) {
      facts.push({
        folder: "central",
        key: "Resources",
        values: data.central.map(
          (r) => `\`${r.key}\` (${resourceModeLabel(r)})`,
        ),
      });
    }
    return facts;
  },
});
