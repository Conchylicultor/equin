import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { pluginIdSegments } from "@plugins/framework/plugins/plugin-id/core";
import type {
  Edge,
  EdgeGraph,
  MembershipState,
} from "@plugins/plugin-meta/plugins/closure/core";
import type {
  GraphCanvasNode,
  GraphCanvasEdge,
} from "@plugins/primitives/plugins/graph-canvas/web";
import { STATE_TINT } from "@plugins/apps/plugins/studio/plugins/membership-tint/web";

/** Which directions of the dependency graph to walk from the focus node. */
export type Direction = "both" | "deps" | "dependents";

export interface SubgraphOpts {
  depth: number;
  cap: number;
  /** Default "both": deps = forward-only (imports/contributes-to), dependents = reverse-only. */
  direction?: Direction;
}

export interface Subgraph {
  nodeIds: PluginId[];
  edges: Edge[];
  hiddenCount: number;
}

const get = (m: Map<PluginId, PluginId[]>, id: PluginId): PluginId[] => m.get(id) ?? [];

/**
 * BFS outward from `focusId` over the shipped {@link EdgeGraph}.
 *
 * Walks up to `depth` hops, expanding across the four adjacency maps selected by
 * `direction` (forward = deps the node pulls in, reverse = nodes depending on it).
 * Caps the result to `cap` nodes nearest-hop-first (focus always kept) and reports
 * `hiddenCount = reached − kept`. Emits every edge exactly once by walking only the
 * forward maps over the kept set, carrying its real `kind`.
 */
export function focusSubgraph(
  graph: EdgeGraph,
  focusId: PluginId,
  { depth, cap, direction = "both" }: SubgraphOpts,
): Subgraph {
  const wantForward = direction === "both" || direction === "deps";
  const wantReverse = direction === "both" || direction === "dependents";

  // BFS, tracking nearest-hop distance. `order` records discovery order so the
  // cap is stable for ties at the same hop.
  const hop = new Map<PluginId, number>([[focusId, 0]]);
  const order: PluginId[] = [focusId];
  let frontier: PluginId[] = [focusId];

  for (let d = 1; d <= depth; d++) {
    const next: PluginId[] = [];
    for (const id of frontier) {
      const neighbors: PluginId[] = [];
      if (wantForward) {
        neighbors.push(...get(graph.hardForward, id), ...get(graph.softForward, id));
      }
      if (wantReverse) {
        neighbors.push(...get(graph.hardReverse, id), ...get(graph.softReverse, id));
      }
      for (const nb of neighbors) {
        if (hop.has(nb)) continue;
        hop.set(nb, d);
        order.push(nb);
        next.push(nb);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // Cap nearest-hop-first; `order` is already hop-ascending (BFS), so a prefix is
  // the nearest `cap` nodes with the focus first.
  const reached = order.length;
  const keptIds = order.slice(0, Math.max(1, cap));
  const kept = new Set<PluginId>(keptIds);
  const hiddenCount = reached - kept.size;

  // The graph's own edges between kept nodes: each directed edge once, with its
  // true kind (and, for a hard one, why it holds and through which folders).
  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to));

  return { nodeIds: keptIds, edges, hiddenCount };
}

// ── Mapping to the generic graph-canvas API ────────────────────────────────

/** Strong ring for the focus node; subtle ring for entry points. Focus wins. */
const FOCUS_RING = "ring-2 ring-primary";
const ENTRY_RING = "ring-1 ring-primary/40";

/**
 * Maps a derived {@link Subgraph} onto the domain-agnostic graph-canvas API.
 * `membership` is null when no composition is active (→ no tint).
 */
export function toCanvas(
  sub: Subgraph,
  focusId: PluginId,
  membership: Map<PluginId, MembershipState> | null,
): { nodes: GraphCanvasNode[]; edges: GraphCanvasEdge[] } {
  const nodes: GraphCanvasNode[] = sub.nodeIds.map((id) => {
    const state = membership?.get(id) ?? "excluded";
    const tintClass =
      membership && state !== "excluded" ? (STATE_TINT[state] ?? null) : null;
    const ringClass = id === focusId ? FOCUS_RING : state === "entry" ? ENTRY_RING : null;
    const segs = pluginIdSegments(id);
    return {
      id,
      label: segs[segs.length - 1] ?? id,
      title: id,
      tintClass,
      ringClass,
    };
  });

  const edges: GraphCanvasEdge[] = sub.edges.map((e) => ({
    from: e.from,
    to: e.to,
    variant: e.kind === "hard" ? "solid" : "dashed",
  }));

  return { nodes, edges };
}
