import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import {
  APP_CATEGORIES,
  type AppCategory,
} from "@plugins/primitives/plugins/pane/core";
import { shade } from "../shade";
import {
  GROUND_BAND,
  type Box,
  type BuildingSpec,
  type PaintState,
} from "../spec";
import { boxWithin, paintedExtent } from "../testing";
import { categoryOfSeed, kitBuilding } from "./kit-building";
import { chimneySmoke } from "./parts";

const CATEGORIES: readonly (AppCategory | undefined)[] = [
  ...APP_CATEGORIES,
  undefined,
];
const SAMPLE = 320;
const TIMES = [0, 1.1, 2.3, 3.7, 5.2, 7.9];
/** How far the declared extremes may exceed the measured extremes over the sample, per side. */
const TIGHTNESS = 16;

const ids = Array.from({ length: SAMPLE }, (_, i) => `app-${i}`);
const categoryOf = (i: number) => CATEGORIES[i % CATEGORIES.length];

function stateFor(id: string, over: Partial<PaintState> = {}): PaintState {
  return {
    t: 0,
    night: false,
    dusk: false,
    open: false,
    hue: `#${(fnv1a32(id) & 0xffffff).toString(16).padStart(6, "0")}`,
    shade,
    rnd: mulberry32(fnv1a32(id)),
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

interface Measured {
  below: Box | null;
  above: Box | null;
}

/** Everything a spec paints (day and night) and animates, split at the ground band. */
function measure(spec: BuildingSpec, id: string): Measured {
  const out: Measured = { below: null, above: null };
  const take = (draw: Parameters<typeof paintedExtent>[0]) => {
    const e = paintedExtent(draw, -GROUND_BAND);
    out.below = unite(out.below, e.below);
    out.above = unite(out.above, e.above);
  };
  for (const night of [false, true])
    take((g) => spec.paint(g, stateFor(id, { night })));
  for (const t of TIMES) {
    for (const open of [false, true]) {
      take((g) => spec.animate?.(g, stateFor(id, { t, open })));
    }
    const chimney = spec.chimney;
    if (chimney) take((g) => chimneySmoke(g, chimney, t, 1));
  }
  return out;
}

const specs = ids.map((id, i) => ({
  id,
  spec: kitBuilding({ id }, categoryOf(i)),
}));
const measured = specs.map(({ id, spec }) => measure(spec, id));

describe("kitBuilding", () => {
  test("is deterministic: the same app builds the same building", () => {
    for (const [i, id] of ids.slice(0, 40).entries()) {
      const a = kitBuilding({ id }, categoryOf(i));
      const b = kitBuilding({ id }, categoryOf(i));
      expect(b.footprint).toEqual(a.footprint);
      expect(b.lights).toEqual(a.lights);
      expect(b.setting).toEqual(a.setting);
      expect(b.signX).toEqual(a.signX);
      expect(measure(b, id)).toEqual(measure(a, id));
    }
  });

  test("picks a category from the seed when none is declared", () => {
    const seen = new Set<AppCategory>();
    for (const id of ids) seen.add(categoryOfSeed(fnv1a32(id)));
    expect(seen.size).toBe(APP_CATEGORIES.length);
    const a = kitBuilding({ id: "x" }, undefined);
    expect(
      kitBuilding({ id: "x" }, categoryOfSeed(fnv1a32("x"))).setting,
    ).toEqual(a.setting);
  });

  test("a different seed builds a different building", () => {
    const shapes = new Set(
      specs.map(({ spec }) => JSON.stringify(spec.footprint)),
    );
    expect(shapes.size).toBeGreaterThan(SAMPLE / 4);
  });

  test("its settings follow the category", () => {
    expect(kitBuilding({ id: "a" }, "data").setting).toEqual([
      "shore",
      "harbour",
    ]);
    expect(kitBuilding({ id: "a" }, "system").setting).toEqual(["hill"]);
    expect(kitBuilding({ id: "a" }, "play").setting).toEqual([
      "lane",
      "square",
    ]);
  });

  test("the painting never mutates the shared plan: painting twice paints the same", () => {
    const spec = kitBuilding({ id: "twice" }, "life");
    const once = paintedExtent(
      (g) => spec.paint(g, stateFor("twice")),
      -GROUND_BAND,
    );
    spec.paint(measuringSink(), stateFor("twice", { night: true }));
    const again = paintedExtent(
      (g) => spec.paint(g, stateFor("twice")),
      -GROUND_BAND,
    );
    expect(again).toEqual(once);
  });
});

function measuringSink() {
  let sink: Parameters<BuildingSpec["paint"]>[0] | null = null;
  paintedExtent((g) => {
    sink = g;
  }, 0);
  if (!sink) throw new Error("no sink");
  return sink;
}

describe("kitBuilding footprint", () => {
  test("declares everything the building paints and animates", () => {
    const violations: string[] = [];
    specs.forEach(({ id, spec }, i) => {
      const m = measured[i];
      if (!m) throw new Error("missing measurement");
      const { ground, upper } = spec.footprint;
      if (m.below && !boxWithin(m.below, ground, 0)) {
        violations.push(`${id} ground ${fmt(m.below)} outside ${fmt(ground)}`);
      }
      if (m.above) {
        if (!upper)
          violations.push(`${id} paints above the band but declares no upper`);
        else if (!boxWithin(m.above, upper, 0)) {
          violations.push(`${id} upper ${fmt(m.above)} outside ${fmt(upper)}`);
        }
      }
    });
    expect(violations).toEqual([]);
  });

  test("declares tight boxes: each side within a few px of the sample's extreme ink", () => {
    for (const part of ["ground", "upper"] as const) {
      const declared: Box[] = [];
      const ink: Box[] = [];
      specs.forEach(({ spec }, i) => {
        const d = spec.footprint[part];
        const m = measured[i];
        const mm = part === "ground" ? m?.below : m?.above;
        if (d) declared.push(d);
        if (mm) ink.push(mm);
      });
      expect(declared.length).toBeGreaterThan(0);
      const extreme = (boxes: Box[]): Box => [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ];
      const d = extreme(declared);
      const m = extreme(ink);
      const slack = [m[0] - d[0], m[1] - d[1], d[2] - m[2], d[3] - m[3]];
      for (const [side, s] of slack.entries()) {
        expect({ part, side, safe: s >= 0 }).toEqual({
          part,
          side,
          safe: true,
        });
        expect({ part, side, tight: s <= TIGHTNESS }).toEqual({
          part,
          side,
          tight: true,
        });
      }
    }
  });
});

const fmt = (b: Box) => `[${b.map((v) => v.toFixed(1)).join(", ")}]`;
