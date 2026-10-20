import { describe, expect, test } from "bun:test";
import { parseMermaid, type Flowchart } from "../../../core";
import { edgeKeys, layoutFlowchart, pointAlong, straighten } from "./layout";

function flowchart(src: string): Flowchart {
  const r = parseMermaid(src);
  if (r.kind !== "flowchart") throw new Error(`expected flowchart: ${src}`);
  return r.diagram;
}

function lay(src: string, labelWidth = 120) {
  const d = flowchart(src);
  const sizes = new Map(d.nodes.map((n) => [n.id, { width: 200, height: 60 }]));
  const keys = edgeKeys(d);
  const labels = new Map<string, { width: number; height: number }>();
  d.edges.forEach((e, i) => {
    if (e.label) labels.set(keys[i]!, { width: labelWidth, height: 22 });
  });
  return { keys, layout: layoutFlowchart(d, sizes, labels) };
}

describe("layoutFlowchart edges", () => {
  test("a forward edge runs from the bottom centre to the top centre, square to the ranks", () => {
    const { keys, layout } = lay("flowchart TB\nA --> B & C");
    const a = layout.nodes.get("A")!;
    for (const [i, id] of ["B", "C"].entries()) {
      const to = layout.nodes.get(id)!;
      const segs = layout.edges.get(keys[i]!)!.segments;
      expect(segs).toHaveLength(1);
      const c = segs[0]!;
      expect(c.p0).toEqual({ x: a.x, y: a.y + a.height / 2 });
      expect(c.p1).toEqual({ x: to.x, y: to.y - to.height / 2 });
      // Vertical tangents at both ends.
      expect(c.c1.x).toBe(c.p0.x);
      expect(c.c2.x).toBe(c.p1.x);
    }
  });

  test("an edge label sits on its edge, and the ranks part to make room for it", () => {
    const plain = lay("flowchart TB\nA --> B").layout;
    const { keys, layout } = lay("flowchart TB\nA -->|contributes| B");
    const gap = (l: typeof layout) => l.nodes.get("B")!.y - l.nodes.get("A")!.y;
    expect(gap(layout)).toBeGreaterThan(gap(plain));
    const e = layout.edges.get(keys[0]!)!;
    const a = layout.nodes.get("A")!;
    const b = layout.nodes.get("B")!;
    // Straight edge: the label is mid-way, on the line.
    expect(e.label!.x).toBeCloseTo(a.x, 5);
    expect(e.label!.y).toBeCloseTo(
      (a.y + a.height / 2 + b.y - b.height / 2) / 2,
      0,
    );
  });

  test("LR ranks run sideways, and part for a label's width", () => {
    const { keys, layout } = lay("flowchart LR\nA -->|a long label| B", 160);
    const a = layout.nodes.get("A")!;
    const b = layout.nodes.get("B")!;
    expect(b.x - b.width / 2 - (a.x + a.width / 2)).toBeGreaterThanOrEqual(160);
    const c = layout.edges.get(keys[0]!)!.segments[0]!;
    expect(c.p0).toEqual({ x: a.x + a.width / 2, y: a.y });
  });

  test("a back edge keeps a route", () => {
    const { keys, layout } = lay("flowchart TB\nA --> B --> A");
    expect(layout.edges.get(keys[1]!)!.segments.length).toBeGreaterThan(0);
  });
});

describe("straighten", () => {
  test("drops every routing point no node is in the way of", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 50 },
      { x: 0, y: 100 },
    ];
    expect(straighten(pts, [])).toEqual([pts[0]!, pts[2]!]);
  });
  test("keeps the point that steers round a node", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 100 },
    ];
    const box = { x: 0, y: 50, width: 40, height: 20 };
    expect(straighten(pts, [box])).toEqual(pts);
  });
});

test("pointAlong measures by arc length", () => {
  const line = {
    p0: { x: 0, y: 0 },
    c1: { x: 0, y: 25 },
    c2: { x: 0, y: 75 },
    p1: { x: 0, y: 100 },
  };
  expect(pointAlong([line], 0.7).y).toBeCloseTo(70, 0);
});
