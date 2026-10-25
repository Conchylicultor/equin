import { describe, expect, it } from "bun:test";
import {
  paintedBox,
  parseTransform,
  pathPoints,
  type BBoxElement,
} from "./glyph-geometry";

function extent(points: readonly [number, number][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function el(
  tag: string,
  attrs: Record<string, string>,
  children: BBoxElement[] = [],
): BBoxElement {
  return { tag, attrs: new Map(Object.entries(attrs)), children };
}

describe("pathPoints", () => {
  it("follows relative and absolute lines, H/V and close", () => {
    expect(extent(pathPoints("M2 3l4 0V9h-5z"))).toEqual({
      minX: 1,
      minY: 3,
      maxX: 6,
      maxY: 9,
    });
  });

  it("reaches a cubic's extremes, not just its control polygon, and reflects S", () => {
    // Control points reach y=10, the curve only 7.5; S mirrors it below.
    const box = extent(pathPoints("M0 0c0 10 10 10 10 0s10-10 10 0"));
    expect(box.maxY).toBeCloseTo(7.5, 2);
    expect(box.minY).toBeCloseTo(-7.5, 2);
  });

  it("samples arcs, packed flags included", () => {
    // Two half-circle arcs of radius 5 around (15, 10).
    const box = extent(pathPoints("M10 10a5 5 0 1 0 10 0a5 5 0 1 0-10 0"));
    expect(box.minY).toBeCloseTo(5, 2);
    expect(box.maxY).toBeCloseTo(15, 2);
    const packed = extent(pathPoints("M10 10a5 5 0 1010 0"));
    expect(packed.maxY).toBeCloseTo(15, 2);
  });
});

describe("parseTransform", () => {
  it("composes left to right, as SVG does", () => {
    const m = parseTransform("translate(10 0) rotate(90)");
    // (1, 0) rotated 90° is (0, 1), then moved by (10, 0).
    expect(m[0] * 1 + m[4]).toBeCloseTo(10, 6);
    expect(m[1] * 1 + m[5]).toBeCloseTo(1, 6);
  });

  it("throws on a transform it cannot read", () => {
    expect(() => parseTransform("perspective(2)")).toThrow(/unsupported/);
  });
});

describe("paintedBox", () => {
  const attrsOf = (e: BBoxElement) => e.attrs;

  it("applies group transforms and grows stroked shapes by half the stroke", () => {
    const svg = el("svg", {}, [
      el("g", { transform: "scale(2)" }, [
        el("rect", { x: "1", y: "1", width: "2", height: "2" }),
        el("line", {
          x1: "5",
          y1: "5",
          x2: "6",
          y2: "5",
          stroke: "#000",
          "stroke-width": "1",
        }),
      ]),
    ]);
    expect(paintedBox(svg, attrsOf)).toEqual({
      minX: 2,
      minY: 2,
      maxX: 13,
      maxY: 11,
    });
  });

  it("skips what paints nothing and is undefined when nothing paints", () => {
    const svg = el("svg", {}, [
      el("rect", { width: "32", height: "32", fill: "none" }),
      el("rect", { width: "8", height: "8", opacity: "0" }),
    ]);
    expect(paintedBox(svg, attrsOf)).toBeUndefined();
  });
});
