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

/** One cubic Bézier hop of an edge. */
export interface Cubic {
  p0: Point;
  c1: Point;
  c2: Point;
  p1: Point;
}

export interface EdgeGeometry {
  /** The edge's path, end to end, as consecutive cubics. */
  segments: Cubic[];
  /** Where its label sits on the path, or null when it has none. */
  label: Point | null;
}

export interface FlowLayout {
  width: number;
  height: number;
  /** Centre and outer size of each node, by id. */
  nodes: Map<string, Point & Size>;
  /** Each edge's geometry, by `edgeKeys`. */
  edges: Map<string, EdgeGeometry>;
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

// Room between ranks: enough on its own, and more when an edge label must sit
// on the wire between them (the label is not given to dagre, which would route
// the line through a label node and kink it).
const RANK_SEP = 56;
const LABELLED_RANK_SEP = 76;
const LABEL_CLEARANCE = 48;
// How far a straightened edge keeps from a node it does not join.
const NODE_CLEARANCE = 8;

/**
 * Lays the measured nodes out with dagre (ranked, crossing-minimised), then
 * draws each edge the way a person would: a forward edge leaves its node's
 * facing side and enters the next one's, as one smooth curve with tangents
 * along the rank axis — through dagre's routing points only where the straight
 * curve would cut through another node. An edge that runs against the ranks
 * (a cycle) or within one keeps dagre's route, smoothed. Each label sits on its
 * edge: mid-way along a straight one, past the fork on a bending one.
 */
export function layoutFlowchart(
  diagram: Flowchart,
  nodeSizes: Map<string, Size>,
  labelSizes: Map<string, Size>,
): FlowLayout {
  const vertical = diagram.direction === "TB" || diagram.direction === "BT";
  const labels = [...labelSizes.values()];
  const labelRoom = labels.length
    ? Math.max(...labels.map((l) => (vertical ? l.height : l.width)))
    : 0;
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({
    rankdir: diagram.direction,
    nodesep: 28,
    ranksep: labels.length
      ? Math.max(LABELLED_RANK_SEP, labelRoom + LABEL_CLEARANCE)
      : RANK_SEP,
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
  diagram.edges.forEach((edge, i) => {
    g.setEdge(edge.from, edge.to, {}, String(i));
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
  const axis = rankAxis(diagram.direction);
  const keys = edgeKeys(diagram);
  const edges = new Map<string, EdgeGeometry>();
  diagram.edges.forEach((edge, i) => {
    const route = g
      .edge({ v: edge.from, w: edge.to, name: String(i) })
      .points.map((p) => ({ x: p.x, y: p.y }));
    const from = nodes.get(edge.from)!;
    const to = nodes.get(edge.to)!;
    const others = [...nodes]
      .filter(([id]) => id !== edge.from && id !== edge.to)
      .map(([, box]) => box);
    const forward = ranked(from, to, axis);
    const segments = forward
      ? rankedCurve(
          straighten(
            [port(from, axis, 1), ...route.slice(1, -1), port(to, axis, -1)],
            others,
          ),
          axis,
        )
      : smoothCurve(
          route.length >= 2
            ? [
                outline(from, shapeOf.get(edge.from)!, route[1]!),
                ...route.slice(1, -1),
                outline(to, shapeOf.get(edge.to)!, route.at(-2)!),
              ]
            : route,
        );
    const start = segments[0]?.p0;
    const end = segments.at(-1)?.p1;
    const straight =
      !!start &&
      !!end &&
      Math.abs(cross(end, axis) - cross(start, axis)) < 1 &&
      segments.length === 1;
    const label =
      labelSizes.has(keys[i]!) && segments.length > 0
        ? pointAlong(segments, straight || !forward ? 0.5 : 0.7)
        : null;
    edges.set(keys[i]!, { segments, label });
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

/** The rank axis: which coordinate ranks advance along, and which way. */
interface Axis {
  key: "x" | "y";
  sign: 1 | -1;
}

function rankAxis(direction: Flowchart["direction"]): Axis {
  switch (direction) {
    case "TB":
      return { key: "y", sign: 1 };
    case "BT":
      return { key: "y", sign: -1 };
    case "LR":
      return { key: "x", sign: 1 };
    case "RL":
      return { key: "x", sign: -1 };
  }
}

const half = (box: Size, axis: Axis) =>
  (axis.key === "y" ? box.height : box.width) / 2;
const along = (p: Point, axis: Axis) => p[axis.key] * axis.sign;
const cross = (p: Point, axis: Axis) => (axis.key === "y" ? p.x : p.y);

/** Whether `to` lies wholly further along the ranks than `from`. */
function ranked(from: Point & Size, to: Point & Size, axis: Axis): boolean {
  return (
    along(to, axis) - half(to, axis) >=
    along(from, axis) + half(from, axis) - 0.5
  );
}

/** The middle of the side a box faces down the ranks (`side` 1) or up them (-1). */
function port(box: Point & Size, axis: Axis, side: 1 | -1): Point {
  const d = half(box, axis) * axis.sign * side;
  return axis.key === "y"
    ? { x: box.x, y: box.y + d }
    : { x: box.x + d, y: box.y };
}

/**
 * The fewest of the points that still keep each chord between two kept points
 * clear of every other node — dagre's routing points survive only where a
 * node is in the way.
 */
export function straighten(
  points: readonly Point[],
  obstacles: ReadonlyArray<Point & Size>,
): Point[] {
  const out = [points[0]!];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && obstacles.some((o) => hits(points[i]!, points[j]!, o)))
      j--;
    out.push(points[j]!);
    i = j;
  }
  return out;
}

/** Whether the segment a→b passes through the box (grown by the clearance). */
function hits(a: Point, b: Point, box: Point & Size): boolean {
  const x0 = box.x - box.width / 2 - NODE_CLEARANCE;
  const x1 = box.x + box.width / 2 + NODE_CLEARANCE;
  const y0 = box.y - box.height / 2 - NODE_CLEARANCE;
  const y1 = box.y + box.height / 2 + NODE_CLEARANCE;
  // Liang–Barsky: clip the segment's parameter range to the box.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Cubics through the points, every tangent along the rank axis: each hop
 * leaves and arrives square to the ranks, so a straight hop stays straight and
 * a sideways one is a clean S.
 */
function rankedCurve(points: readonly Point[], axis: Axis): Cubic[] {
  const out: Cubic[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const k = (p1[axis.key] - p0[axis.key]) / 2;
    const c1 = { ...p0, [axis.key]: p0[axis.key] + k };
    const c2 = { ...p1, [axis.key]: p1[axis.key] - k };
    out.push({ p0, c1, c2, p1 });
  }
  return out;
}

/** Cubics through the points as a Catmull-Rom spline — dagre's route, rounded. */
function smoothCurve(points: readonly Point[]): Cubic[] {
  const out: Cubic[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const prev = points[i - 1] ?? p0;
    const next = points[i + 2] ?? p1;
    out.push({
      p0,
      c1: { x: p0.x + (p1.x - prev.x) / 6, y: p0.y + (p1.y - prev.y) / 6 },
      c2: { x: p1.x - (next.x - p0.x) / 6, y: p1.y - (next.y - p0.y) / 6 },
      p1,
    });
  }
  return out;
}

function at(c: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p1.x,
    y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p1.y,
  };
}

/** The point `fraction` of the way along the path, by arc length. */
export function pointAlong(
  segments: readonly Cubic[],
  fraction: number,
): Point {
  const STEPS = 32;
  const samples: Point[] = [segments[0]!.p0];
  for (const c of segments) {
    for (let s = 1; s <= STEPS; s++) samples.push(at(c, s / STEPS));
  }
  const lengths = [0];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    lengths.push(lengths[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const target = lengths.at(-1)! * fraction;
  const i = Math.max(
    1,
    lengths.findIndex((l) => l >= target),
  );
  const a = samples[i - 1]!;
  const b = samples[i]!;
  const span = lengths[i]! - lengths[i - 1]!;
  const t = span === 0 ? 0 : (target - lengths[i - 1]!) / span;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
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
 * The path's SVG `d`, with the last `trim` px (and the first `trimStart` px)
 * left off so the line ends where an arrowhead begins.
 */
export function edgePath(
  segments: readonly Cubic[],
  trim: number,
  trimStart: number,
): string {
  if (segments.length === 0) return "";
  const cs = segments.map((c) => ({ ...c }));
  const last = cs.at(-1)!;
  const [p1, c2] = pull(last.p1, last.c2, trim);
  cs[cs.length - 1] = { ...last, p1, c2 };
  const first = cs[0]!;
  const [p0, c1] = pull(first.p0, first.c1, trimStart);
  cs[0] = { ...first, p0, c1 };
  let d = `M${cs[0]!.p0.x},${cs[0]!.p0.y}`;
  for (const c of cs) {
    d += ` C${c.c1.x},${c.c1.y} ${c.c2.x},${c.c2.y} ${c.p1.x},${c.p1.y}`;
  }
  return d;
}

/** An end point and its control point, moved `by` px back along the tangent. */
function pull(end: Point, control: Point, by: number): [Point, Point] {
  if (by <= 0) return [end, control];
  const len = Math.hypot(control.x - end.x, control.y - end.y);
  if (len <= by) return [end, control];
  const ux = (control.x - end.x) / len;
  const uy = (control.y - end.y) / len;
  return [
    { x: end.x + ux * by, y: end.y + uy * by },
    { x: control.x + ux * by, y: control.y + uy * by },
  ];
}

/** The angle (radians) the path arrives at its end (or start) with. */
export function arrivalAngle(
  segments: readonly Cubic[],
  atStart: boolean,
): number {
  const c = atStart ? segments[0]! : segments.at(-1)!;
  const [p, q] = atStart
    ? [c.p0, tangentFrom(c.p0, c.c1, c.c2, c.p1)]
    : [c.p1, tangentFrom(c.p1, c.c2, c.c1, c.p0)];
  return Math.atan2(p.y - q.y, p.x - q.x);
}

/** The nearest distinct control point to an end — its tangent direction. */
function tangentFrom(end: Point, ...rest: Point[]): Point {
  return rest.find((p) => Math.hypot(p.x - end.x, p.y - end.y) > 0.01) ?? end;
}
