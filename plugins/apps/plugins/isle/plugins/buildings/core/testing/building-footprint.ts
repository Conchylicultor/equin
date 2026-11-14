// The footprint test every bespoke building runs: paint it by day, at dusk and
// at night, animate it at many moments with the door shut and open (and its
// chimney's smoke), measure
// the ink (`paintedExtent`, no canvas) and check it against the DECLARED
// footprint — inside it, and the footprint no bigger than the ink by more than
// a few px a side (an oversized footprint wastes the island).

import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import { chimneySmoke } from "../internal/parts";
import { shade } from "../shade";
import {
  GROUND_BAND,
  type Box,
  type BuildingSpec,
  type PaintState,
} from "../spec";
import { paintedExtent, type PaintedExtent } from "./painted-extent";

/** How far a declared side may lie beyond the measured ink, px. */
export const FOOTPRINT_SLACK = 16;

const TIMES = Array.from({ length: 160 }, (_, i) => i * 0.37);
const LIGHTS = [
  { night: false, dusk: false },
  { night: false, dusk: true },
  { night: true, dusk: false },
] as const;

/** The paint state the renderer hands an app's building (its random stream seeded from the app id). */
function stateFor(appId: string, over: Partial<PaintState>): PaintState {
  return {
    t: 0,
    night: false,
    dusk: false,
    open: false,
    hue: "#8a7a5c",
    shade,
    rnd: mulberry32(fnv1a32(appId)),
    glyph: (g, cx, cy, size) =>
      g.fillRect(cx - size / 2, cy - size / 2, size, size),
    ...over,
  };
}

const unite = (a: Box | null, b: Box | null): Box | null =>
  !a
    ? b
    : !b
      ? a
      : [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[2], b[2]),
          Math.max(a[3], b[3]),
        ];

/** All the ink a building paints and animates, in every light, split at the ground band. */
export function measureBuilding(
  spec: BuildingSpec,
  appId: string,
): PaintedExtent {
  let below: Box | null = null;
  let above: Box | null = null;
  const take = (draw: Parameters<typeof paintedExtent>[0]) => {
    const e = paintedExtent(draw, -GROUND_BAND);
    below = unite(below, e.below);
    above = unite(above, e.above);
  };
  for (const light of LIGHTS) {
    take((g) => spec.paint(g, stateFor(appId, light)));
    if (spec.animate)
      for (const t of TIMES)
        for (const open of [false, true])
          take((g) =>
            spec.animate?.(g, stateFor(appId, { ...light, t, open })),
          );
  }
  // the smoke the renderer draws from its chimney, at its thickest
  const chimney = spec.chimney;
  if (chimney)
    for (const t of TIMES) take((g) => chimneySmoke(g, chimney, t, 1));
  return { below, above };
}

const fmt = (b: Box) => `[${b.map((v) => v.toFixed(1)).join(", ")}]`;

/** What is wrong with a box declared for measured ink: ink outside it, or a side too loose. */
function boxProblems(name: string, declared: Box, ink: Box): string[] {
  const slack = [
    ink[0] - declared[0],
    ink[1] - declared[1],
    declared[2] - ink[2],
    declared[3] - ink[3],
  ];
  const out: string[] = [];
  ["x0", "y0", "x1", "y1"].forEach((side, i) => {
    const s = slack[i]!;
    if (s < 0)
      out.push(
        `${name} ${side}: ink ${-s.toFixed(1)} px outside (ink ${fmt(ink)}, declared ${fmt(declared)})`,
      );
    // the ground box's top is the band line itself whenever ink crosses it
    else if (s > FOOTPRINT_SLACK)
      out.push(
        `${name} ${side}: ${s.toFixed(1)} px looser than the ink (ink ${fmt(ink)}, declared ${fmt(declared)})`,
      );
  });
  return out;
}

/** Every way a building's declared footprint disagrees with its ink (none: it holds). */
export function footprintProblems(spec: BuildingSpec, appId: string): string[] {
  const m = measureBuilding(spec, appId);
  const { ground, upper } = spec.footprint;
  const out: string[] = [];
  if (m.below) out.push(...boxProblems("ground", ground, m.below));
  else out.push("paints nothing on the ground band");
  if (m.above && upper) out.push(...boxProblems("upper", upper, m.above));
  else if (m.above)
    out.push(`paints above the band ${fmt(m.above)} but declares no upper`);
  else if (upper)
    out.push("declares an upper but paints nothing above the band");
  return out;
}

/** Registers the footprint suite of one app's building: `testBuildingFootprint("places", lighthouse)`. */
export function testBuildingFootprint(appId: string, spec: BuildingSpec): void {
  describe(`${appId}'s building`, () => {
    test("its declared footprint holds all its ink (day, dusk, night, animated, door open and shut), tightly", () => {
      expect(footprintProblems(spec, appId)).toEqual([]);
    });
    test("paints the same picture from the same app", () => {
      const once = paintedExtent(
        (g) => spec.paint(g, stateFor(appId, {})),
        -GROUND_BAND,
      );
      const again = paintedExtent(
        (g) => spec.paint(g, stateFor(appId, {})),
        -GROUND_BAND,
      );
      expect(again).toEqual(once);
    });
  });
}
