import {
  hostRuntimeFolders,
  type HostId,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import type { Edge, EdgeGraph, HardEdge } from "./types";

// A host view's source graph — so a view of a view is cut from the whole
// graph, never from a narrower one (a desktop view of a browser view would
// otherwise miss every `machine/` edge).
const sourceOf = new WeakMap<EdgeGraph, EdgeGraph>();
const views = new WeakMap<EdgeGraph, Map<string, EdgeGraph>>();

/**
 * The graph as a set of hosts sees it: only the hard edges that hold through a
 * folder one of `hosts` executes (`hostRuntimeFolders` — the union for several
 * hosts). Soft edges, subtrees, usage rules and host providers are host-free
 * and carried as they are.
 *
 * `classifyEdges` returns the graph of EVERY shipping folder; a closure is
 * always walked over a view. `resolveComposition` and the causality queries
 * take the view their manifest's `hosts` declare, so a caller holding a
 * manifest never calls this — it is for a caller walking the graph directly
 * (`removalClosure`, `hardClosure`) on a composition's behalf.
 *
 * Memoized per (source graph, host set): views are cheap to hold and the
 * Studio asks for the same one on every render.
 */
export function graphForHosts(
  graph: EdgeGraph,
  hosts: readonly HostId[],
): EdgeGraph {
  if (hosts.length === 0)
    throw new Error("closure: a host view needs at least one host.");
  const source = sourceOf.get(graph) ?? graph;
  const key = [...new Set(hosts)].sort().join(",");
  let byKey = views.get(source);
  if (!byKey) views.set(source, (byKey = new Map()));
  const cached = byKey.get(key);
  if (cached) return cached;

  const folders = hostRuntimeFolders(hosts);
  const hardForward = new Map<PluginId, PluginId[]>();
  const hardReverse = new Map<PluginId, PluginId[]>();
  for (const id of source.hardForward.keys()) {
    hardForward.set(id, []);
    hardReverse.set(id, []);
  }
  const edges: Edge[] = [];
  for (const e of source.edges) {
    if (e.kind === "hard") {
      if (!e.runtimes.some((rt) => folders.has(rt))) continue;
      hardForward.get(e.from)!.push(e.to);
      hardReverse.get(e.to)!.push(e.from);
    }
    edges.push(e);
  }
  const view: EdgeGraph = { ...source, hardForward, hardReverse, edges };
  sourceOf.set(view, source);
  byKey.set(key, view);
  return view;
}

const hardIndex = new WeakMap<EdgeGraph, Map<string, HardEdge>>();

/** The hard edge `from → to` of `graph`, if any — what an inclusion step
 *  reads to say why the hop holds. Indexed once per graph. */
export function hardEdgeOf(
  graph: EdgeGraph,
  from: PluginId,
  to: PluginId,
): HardEdge | undefined {
  let index = hardIndex.get(graph);
  if (!index) {
    index = new Map();
    for (const e of graph.edges)
      if (e.kind === "hard") index.set(`${e.from}\0${e.to}`, e);
    hardIndex.set(graph, index);
  }
  return index.get(`${from}\0${to}`);
}
