import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ParsedPattern } from "@plugins/plugin-meta/plugins/closure/plugins/entry-pattern/core";
import type { EdgeGraph } from "./types";

/**
 * The plugin ids a parsed pattern matches:
 *
 *  - root (`**`) → every node id in the graph.
 *  - id → its `base` plus (when `.**` was present) the base's whole subtree. An
 *    unknown base — one with no `subtree` entry in the graph — still matches
 *    `{base}` inertly, mirroring the engine's existing unknown-id rule (an unknown
 *    seed passes through and contributes no further edges).
 */
export function matchEntryPattern(
  p: ParsedPattern,
  graph: EdgeGraph,
): Set<PluginId> {
  if (p.kind === "root") return new Set<PluginId>(allNodeIds(graph));
  const out = new Set<PluginId>([p.base]);
  if (p.subtree) for (const d of graph.subtree.get(p.base) ?? []) out.add(d);
  return out;
}

/**
 * Every node id is a key of the four adjacency maps (classifyEdges seeds them all).
 * Lives here rather than in `resolve-composition.ts` because the root `**` form
 * and the membership walk must agree on what "every node" means — one spelling,
 * one place to change it.
 */
export function allNodeIds(graph: EdgeGraph): Iterable<PluginId> {
  return graph.hardForward.keys();
}
