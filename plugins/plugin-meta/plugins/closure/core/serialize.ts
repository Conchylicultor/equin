import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { Edge, EdgeGraph, UsageRule } from "./types";

/**
 * JSON-safe shape of an {@link EdgeGraph}. The five adjacency `Map`s become plain
 * `Record<string, string[]>` (PluginId is a branded string, so the keys/values are
 * already JSON-safe); `edges` and `rules` are carried verbatim. This is the wire shape shipped
 * by the composition data endpoint and rehydrated client-side via
 * {@link deserializeEdgeGraph}.
 */
export interface SerializedEdgeGraph {
  hardForward: Record<string, PluginId[]>;
  hardReverse: Record<string, PluginId[]>;
  softForward: Record<string, PluginId[]>;
  softReverse: Record<string, PluginId[]>;
  subtree: Record<string, PluginId[]>;
  edges: Edge[];
  rules: UsageRule[];
}

function mapToRecord(map: Map<PluginId, PluginId[]>): Record<string, PluginId[]> {
  const out: Record<string, PluginId[]> = {};
  for (const [key, value] of map) out[key] = value;
  return out;
}

function recordToMap(record: Record<string, PluginId[]>): Map<PluginId, PluginId[]> {
  const out = new Map<PluginId, PluginId[]>();
  for (const key of Object.keys(record)) out.set(key as PluginId, record[key]!);
  return out;
}

/** Convert an {@link EdgeGraph} into its JSON-safe {@link SerializedEdgeGraph}. Pure. */
export function serializeEdgeGraph(graph: EdgeGraph): SerializedEdgeGraph {
  return {
    hardForward: mapToRecord(graph.hardForward),
    hardReverse: mapToRecord(graph.hardReverse),
    softForward: mapToRecord(graph.softForward),
    softReverse: mapToRecord(graph.softReverse),
    subtree: mapToRecord(graph.subtree),
    edges: graph.edges,
    rules: graph.rules,
  };
}

/** Rehydrate an {@link EdgeGraph} from its {@link SerializedEdgeGraph}. Pure; inverse of
 *  {@link serializeEdgeGraph}. */
export function deserializeEdgeGraph(s: SerializedEdgeGraph): EdgeGraph {
  return {
    hardForward: recordToMap(s.hardForward),
    hardReverse: recordToMap(s.hardReverse),
    softForward: recordToMap(s.softForward),
    softReverse: recordToMap(s.softReverse),
    subtree: recordToMap(s.subtree),
    edges: s.edges,
    rules: s.rules,
  };
}
