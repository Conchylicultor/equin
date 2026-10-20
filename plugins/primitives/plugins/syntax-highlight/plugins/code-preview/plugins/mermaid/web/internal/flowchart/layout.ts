import dagre from "dagre";
import type { Flowchart, FlowNodeShape } from "../../../core";

export interface Size {
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  /** Centre and outer size of each node, by id. */
  nodes: Map<string, Point & Size>;
  /** Each edge (by `edgeKeys`): its path through dagre's points, its label centre. */
  edges: Map<string, { points: Point[]; label: Point | null }>;
  /** Each subgraph's box, by id. */
  groups: Map<string, Point & Size>;
}

/**
 * The outer box a shape needs around its measured label: a diamond or a circle
 * must contain the label's rectangle, a cylinder adds its caps.
 */
export function shapeSize(shape: FlowNodeShape, label: Size): Size {
  const { width: w, height: h } = label;
  switch (shape) {
    case "decision": {
      // |x|/a + |y|/b ≤ 1 holds at the label's corners when a = b = (w + h) / 2.
      const d = w + h;
      return { width: d, height: Math.max(h + 24, d * 0.62) };
    }
    case "circle": {
      const d = Math.hypot(w, h);
      return { width: d, height: d };
    }
    case "hexagon":
      return { width: w + h * 0.9, height: h };
    case "database":
      return { width: w, height: h + 14 };
    case "rect":
    case "round":
    case "stadium":
    case "subroutine":
      return { width: w, height: h };
  }
}

const GROUP_PAD = 18;

/**
 * A stable name per edge — its ends and how many earlier edges join the same
 * pair — so a layout still applies to the edges it knew after the source gains
 * or loses one elsewhere.
 */
export function edgeKeys(diagram: Flowchart): string[] {
  const seen = new Map<string, number>();
  return diagram.edges.map((e) => {
    const pair = `${e.from}\u0000${e.to}`;
    const n = seen.get(pair) ?? 0;
    seen.set(pair, n + 1);
    return `${pair}\u0000${n}`;
  });
}

/**
 * Lays the measured nodes and edge labels out with dagre (ranked, crossing-
 * minimised, edge labels given their own room), then replaces each edge's two
 * end points with where the line meets the node's real outline — dagre only
 * knows rectangles.
 */
export function layoutFlowchart(
  diagram: Flowchart,
  nodeSizes: Map<string, Size>,
  labelSizes: Map<string, Size>,
): FlowLayout {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({
    rankdir: diagram.direction,
    nodesep: 40,
    ranksep: 56,
    edgesep: 20,
    marginx: 12,
    marginy: 12,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const group of diagram.groups) {
    g.setNode(group.id, {
      paddingTop: GROUP_PAD + 14,
      paddingBottom: GROUP_PAD,
      paddingLeft: GROUP_PAD,
      paddingRight: GROUP_PAD,
    });
  }
  for (const group of diagram.groups) {
    if (group.parent) g.setParent(group.id, group.parent);
  }
  for (const node of diagram.nodes) {
    const size = nodeSizes.get(node.id);
    if (!size)
      throw new Error(`flowchart layout: node ${node.id} was not measured`);
    g.setNode(node.id, { ...size });
    if (node.group) g.setParent(node.id, node.group);
  }
  const keys = edgeKeys(diagram);
  diagram.edges.forEach((edge, i) => {
    const label = labelSizes.get(keys[i]!);
    g.setEdge(
      edge.from,
      edge.to,
      label ? { width: label.width, height: label.height, labelpos: "c" } : {},
      String(i),
    );
  });

  dagre.layout(g);

  const nodes = new Map<string, Point & Size>();
  for (const node of diagram.nodes) {
    const n = g.node(node.id);
    nodes.set(node.id, { x: n.x, y: n.y, width: n.width, height: n.height });
  }
  const groups = new Map<string, Point & Size>();
  for (const group of diagram.groups) {
    const n = g.node(group.id);
    groups.set(group.id, { x: n.x, y: n.y, width: n.width, height: n.height });
  }
  const shapeOf = new Map(diagram.nodes.map((n) => [n.id, n.shape]));
  const edges = new Map<string, { points: Point[]; label: Point | null }>();
  diagram.edges.forEach((edge, i) => {
    const e = g.edge({ v: edge.from, w: edge.to, name: String(i) });
    const points = e.points.map((p) => ({ x: p.x, y: p.y }));
    const from = nodes.get(edge.from)!;
    const to = nodes.get(edge.to)!;
    if (points.length >= 2) {
      points[0] = outline(from, shapeOf.get(edge.from)!, points[1]!);
      points[points.length - 1] = outline(
        to,
        shapeOf.get(edge.to)!,
        points[points.length - 2]!,
      );
    }
    const label =
      labelSizes.has(keys[i]!) && e.x !== undefined && e.y !== undefined
        ? { x: e.x, y: e.y }
        : null;
    edges.set(keys[i]!, { points, label });
  });

  const graph = g.graph();
  return {
    width: graph.width ?? 0,
    height: graph.height ?? 0,
    nodes,
    edges,
    groups,
  };
}

/**
 * Where the line from `toward` to the node's centre crosses the node's outline.
 */
function outline(
  node: Point & Size,
  shape: FlowNodeShape,
  toward: Point,
): Point {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  if (dx === 0 && dy === 0) return { x: node.x, y: node.y };
  const a = node.width / 2;
  const b = node.height / 2;
  let t: number;
  switch (shape) {
    case "decision":
      t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
      break;
    case "circle":
      t = a / Math.hypot(dx, dy);
      break;
    case "rect":
    case "round":
    case "stadium":
    case "subroutine":
    case "hexagon":
    case "database":
      t = Math.min(
        dx === 0 ? Infinity : a / Math.abs(dx),
        dy === 0 ? Infinity : b / Math.abs(dy),
      );
  }
  return { x: node.x + dx * t, y: node.y + dy * t };
}

/**
 * A smooth path through the points: straight to the midpoint of each segment,
 * curving through every interior point — a rounded version of dagre's polyline.
 * The last `trim` px are left off so the line ends where an arrowhead begins.
 */
export function edgePath(
  points: readonly Point[],
  trim: number,
  trimStart: number,
): string {
  if (points.length < 2) return "";
  const pts = points.map((p) => ({ ...p }));
  shorten(pts, pts.length - 1, pts.length - 2, trim);
  shorten(pts, 0, 1, trimStart);
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const next = pts[i + 1]!;
    const mid =
      i === pts.length - 2
        ? next
        : { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
    d += ` Q${p.x},${p.y} ${mid.x},${mid.y}`;
  }
  if (pts.length === 2) d += ` L${pts[1]!.x},${pts[1]!.y}`;
  return d;
}

function shorten(pts: Point[], end: number, prev: number, by: number): void {
  if (by <= 0) return;
  const p = pts[end]!;
  const q = pts[prev]!;
  const len = Math.hypot(p.x - q.x, p.y - q.y);
  if (len <= by) return;
  pts[end] = {
    x: p.x + ((q.x - p.x) * by) / len,
    y: p.y + ((q.y - p.y) * by) / len,
  };
}

/** The angle (radians) the path arrives at its `end` point with. */
export function arrivalAngle(
  points: readonly Point[],
  atStart: boolean,
): number {
  const [p, q] = atStart
    ? [points[0]!, points[1]!]
    : [points.at(-1)!, points.at(-2)!];
  return Math.atan2(p.y - q.y, p.x - q.x);
}
