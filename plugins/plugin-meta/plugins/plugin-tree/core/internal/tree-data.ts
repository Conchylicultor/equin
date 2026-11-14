import { z } from "zod";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";
import type { PluginNode, PluginTreeData } from "./plugin-tree";

/**
 * A plugin tree as JSON: each node's fields and facets, nested. What a tree
 * compares as (a fresh build against one kept up to date), and the shape a
 * {@link PluginNodeDelta} extends.
 *
 * A node carries no absolute `dir`: a reader derives it from its own plugins
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

const facetsSchema = wholeRecord(z.unknown(), {
  reason: "one entry per facet extractor — a closed set of a few dozen",
});

/**
 * A tree as what changed since the last one its reader holds — how a faceted
 * tree kept up to date out of process (`plugin-tree/faceted`'s index) reaches
 * the serving backend. The skeleton (every node, nested, with its structure
 * fields) always travels: it is small. A node's facets travel as their JSON
 * text only when they differ from what was last sent; `null` says "as you
 * already hold". So a backend parses the facets of the plugins that changed,
 * not the whole tree's.
 */
export interface PluginNodeDelta extends Omit<
  PluginNodeJson,
  "children" | "facets"
> {
  children: PluginNodeDelta[];
  /** The node's facets as JSON text, or null when unchanged since the last delta. */
  facets: string | null;
}

export interface PluginTreeDelta {
  roots: PluginNodeDelta[];
}

/**
 * The structure of `tree` alone, as a whole delta: every node with its
 * structure fields and no facets — how the faceted index's holder hands its
 * structure to the backend as soon as it is built, before any facet is read
 * (read back by {@link pluginTreeFromDelta} with no previous tree).
 */
export function pluginStructureDelta(tree: PluginTreeData): PluginTreeDelta {
  const toDelta = (node: PluginNode): PluginNodeDelta => ({
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
    children: node.children.map(toDelta),
    facets: "{}",
  });
  return { roots: tree.roots.map(toDelta) };
}

/**
 * How a faceted index (`plugin-tree/faceted`'s `openFacetedIndex`) started
 * its file set: resumed from the checkpoint an earlier process left, with the
 * number of paths the journal named as changed since, or cold — listed whole
 * by git — and why.
 */
export type FacetedStart =
  { kind: "resumed"; changed: number } | { kind: "cold"; reason: string };

/**
 * The delta of `tree` against `sent` (each node's facets text as last sent,
 * by path — what {@link pluginTreeFromDelta}'s reader holds). Updates `sent`
 * to the tree's own texts, dropping nodes the tree no longer has. Returns the
 * delta and how many nodes' facets it carries.
 */
export function pluginTreeDelta(
  tree: PluginTreeData,
  sent: Map<string, string>,
): { delta: PluginTreeDelta; changed: number } {
  let changed = 0;
  const seen = new Set<string>();
  const toDelta = (node: PluginNode): PluginNodeDelta => {
    seen.add(node.path);
    const text = JSON.stringify(node.facets);
    const same = sent.get(node.path) === text;
    if (!same) {
      sent.set(node.path, text);
      changed++;
    }
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
      children: node.children.map(toDelta),
      facets: same ? null : text,
    };
  };
  const roots = tree.roots.map(toDelta);
  for (const path of [...sent.keys()]) if (!seen.has(path)) sent.delete(path);
  return { delta: { roots }, changed };
}

/**
 * The tree a delta describes, its unchanged facets taken from `previous` (the
 * tree read off the delta before — null for a first, whole one). A delta
 * naming a node as unchanged that `previous` does not hold throws: the reader
 * and the writer disagree on what was sent, and a tree with a hole would read
 * as a plugin declaring nothing.
 */
export function pluginTreeFromDelta(
  pluginsRoot: AppPath,
  delta: PluginTreeDelta,
  previous: PluginTreeData | null,
): PluginTreeData {
  if (delta.roots.length === 0)
    throw new Error(
      `[plugin-tree] the tree delta for ${pluginsRoot} holds no plugin — refusing it rather than reading it as an empty checkout.`,
    );
  const byDir = new Map<string, PluginNode>();
  const byPath = new Map<string, PluginNode>();
  const toNode = (n: PluginNodeDelta): PluginNode => {
    let facets: Record<string, unknown>;
    if (n.facets !== null) {
      facets = facetsSchema.parse(JSON.parse(n.facets));
    } else {
      const held = previous?.byPath.get(n.path);
      if (held === undefined)
        throw new Error(
          `[plugin-tree] the tree delta for ${pluginsRoot} says ${n.path}'s facets are unchanged, but no earlier tree holds that plugin.`,
        );
      facets = held.facets;
    }
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
      facets,
    };
    byDir.set(node.dir, node);
    byPath.set(node.path, node);
    return node;
  };
  const roots = delta.roots.map(toNode);
  return { pluginsRoot, byDir, byPath, roots };
}
