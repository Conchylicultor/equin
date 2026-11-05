import { z } from "zod";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import type { PluginNode, PluginTreeData } from "./plugin-tree";

/**
 * A plugin tree as JSON — how a tree crosses a process boundary. The faceted
 * tree is built out of process (the `plugin-tree-facets` command,
 * `plugin-tree/faceted`) and read back by the serving backend through
 * {@link pluginTreeFromJson}: the facet data is already JSON (every facet's
 * extract is stored as a record's text), so only the indexes are rebuilt.
 *
 * A node carries no absolute `dir`: the reader derives it from its own plugins
 * root and the node's `path`, the same join the build made.
 */
export interface PluginNodeJson {
  path: string;
  name: string;
  id: PluginId;
  description?: string;
  descriptions: PluginNode["descriptions"];
  loadBearing: boolean;
  collapsed: boolean;
  compositionRoot: boolean;
  runtimes: PluginNode["runtimes"];
  children: PluginNodeJson[];
  facets: Record<string, unknown>;
}

export interface PluginTreeJson {
  roots: PluginNodeJson[];
}

const TREE_REASON =
  "this checkout's plugin tree — one node per plugin (about 1.5k), the code's own structure";

const runtimesSchema = z.object({
  web: z.boolean(),
  server: z.boolean(),
  machine: z.boolean(),
  central: z.boolean(),
});

const nodeSchema: z.ZodType<PluginNodeJson> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    id: z.custom<PluginId>((v) => typeof v === "string"),
    description: z.string().optional(),
    descriptions: z.object({
      web: z.string().optional(),
      server: z.string().optional(),
      machine: z.string().optional(),
      central: z.string().optional(),
    }),
    loadBearing: z.boolean(),
    collapsed: z.boolean(),
    compositionRoot: z.boolean(),
    runtimes: runtimesSchema,
    children: wholeList(nodeSchema, { reason: TREE_REASON }),
    facets: wholeRecord(z.unknown(), {
      reason: "one entry per facet extractor — a closed set of a few dozen",
    }),
  }),
);

const treeSchema = z.object({
  roots: wholeList(nodeSchema, { reason: TREE_REASON }),
});

function nodeToJson(node: PluginNode): PluginNodeJson {
  return {
    path: node.path,
    name: node.name,
    id: node.id,
    ...(node.description === undefined
      ? {}
      : { description: node.description }),
    descriptions: node.descriptions,
    loadBearing: node.loadBearing,
    collapsed: node.collapsed,
    compositionRoot: node.compositionRoot,
    runtimes: node.runtimes,
    children: node.children.map(nodeToJson),
    facets: node.facets,
  };
}

/** The tree as JSON (see {@link PluginTreeJson}). */
export function pluginTreeToJson(tree: PluginTreeData): PluginTreeJson {
  return { roots: tree.roots.map(nodeToJson) };
}

/**
 * A tree read back from its JSON, rooted at `pluginsRoot`. Parsed, so a
 * payload of another shape — or one with no plugin at all — throws here,
 * instead of reaching a consumer as a tree with missing parts.
 */
export function pluginTreeFromJson(
  pluginsRoot: AppPath,
  json: unknown,
): PluginTreeData {
  const parsed = treeSchema.parse(json);
  // A checkout always has plugins: an empty tree is a writer that wrote
  // nothing, and read as data it would say "no plugin declares anything".
  if (parsed.roots.length === 0)
    throw new Error(
      `[plugin-tree] the tree read for ${pluginsRoot} holds no plugin — refusing it rather than reading it as an empty checkout.`,
    );
  const byDir = new Map<string, PluginNode>();
  const byPath = new Map<string, PluginNode>();
  const toNode = (n: PluginNodeJson): PluginNode => {
    const node: PluginNode = {
      dir: joinAppPath(pluginsRoot, ...n.path.split("/")),
      path: n.path,
      name: n.name,
      id: n.id,
      ...(n.description === undefined ? {} : { description: n.description }),
      descriptions: n.descriptions,
      loadBearing: n.loadBearing,
      collapsed: n.collapsed,
      compositionRoot: n.compositionRoot,
      runtimes: n.runtimes,
      children: n.children.map(toNode),
      facets: n.facets,
    };
    byDir.set(node.dir, node);
    byPath.set(node.path, node);
    return node;
  };
  const roots = parsed.roots.map(toNode);
  return { pluginsRoot, byDir, byPath, roots };
}
