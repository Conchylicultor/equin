import {
  type PluginTree,
  type PluginNode as TreePluginNode,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import type { PluginNode, PluginTreePayload } from "../../core/types";

function tally(
  node: PluginNode,
  totals: { plugins: number; loadBearing: number; umbrellas: number },
) {
  totals.plugins += 1;
  if (node.loadBearing) totals.loadBearing += 1;
  if (node.children.length > 0) totals.umbrellas += 1;
  for (const child of node.children) tally(child, totals);
}

// Structure fields are always present; `facets` is populated only on the faceted
// build (empty `{}` on the structure-only tree). Whether a plugin is in the app
// is NOT on the payload at all: it is a composition question, answered from the
// edge graph plus the manifests the client already holds (`useAppExclusions`),
// and there is no per-node flag left for it to disagree with.
function toApiNode(node: TreePluginNode): PluginNode {
  return {
    path: node.path,
    name: node.name,
    id: node.id,
    description: node.description,
    loadBearing: node.loadBearing,
    collapsed: node.collapsed,
    runtimes: node.runtimes,
    children: node.children.map(toApiNode),
    facets: node.facets,
  };
}

export function treeToPayload(tree: PluginTree): PluginTreePayload {
  const plugins = tree.roots.map(toApiNode);
  const totals = { plugins: 0, loadBearing: 0, umbrellas: 0 };
  for (const p of plugins) tally(p, totals);
  return { pluginsRoot: tree.pluginsRoot, plugins, totals };
}
