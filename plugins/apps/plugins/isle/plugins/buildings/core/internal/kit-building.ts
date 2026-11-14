// The generated building: a kit of parts (archetype, wall material, roof form
// and material, chimney, dormers, porch, windows, a door in the app's accent, a
// hanging bracket sign with its glyph, props by category) assembled from a seed.
// The same seed always builds the same building.

import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import {
  APP_CATEGORIES,
  type AppCategory,
} from "@plugins/primitives/plugins/pane/core";
import type { BuildingSpec, Ctx2D, Light, PaintState, Setting } from "../spec";
import { at } from "./colour";
import { baseSize, footprintBoxes, signX } from "./footprint";
import { smokeAnchor, propsAnchor } from "./layout";
import { spill } from "./parts";
import { paintBuilding } from "./paint";
import { planBuilding, SIZE_CLASSES, type Plan } from "./plan";
import { ink } from "./draw";
import { estimateLights } from "./lights";

/** Where each kind of app likes to stand. */
const SETTING_BY_CATEGORY: Readonly<Record<AppCategory, readonly Setting[]>> = {
  data: ["shore", "harbour"],
  system: ["hill"],
  life: ["square"],
  music: ["square"],
  work: ["lane"],
  create: ["forest"],
  play: ["lane", "square"],
};

/** The category a seed gives an app that declares none. */
export const categoryOfSeed = (seed: number): AppCategory =>
  at(APP_CATEGORIES, (seed >>> 3) % APP_CATEGORIES.length);

/**
 * The generated building of an app: its footprint, setting, night lights, and
 * how to paint it. `seed` defaults to a hash of the app id; `category` (absent:
 * picked from the seed) biases the archetype, the props and the setting.
 */
export function kitBuilding(
  app: { readonly id: string },
  category: AppCategory | undefined,
  seed: number = fnv1a32(app.id),
): BuildingSpec {
  const cat = category ?? categoryOfSeed(seed);
  const p = planBuilding(
    seed,
    cat,
    at(SIZE_CLASSES, seed % SIZE_CLASSES.length),
  );
  const { w, depth } = baseSize(p);
  const { ground, upper } = footprintBoxes(p);
  const lights: readonly Light[] = estimateLights(p);
  const chimney = smokeAnchor(p);
  return {
    footprint: { w, depth, ground, upper },
    setting: SETTING_BY_CATEGORY[cat],
    signX: signX(p),
    lights,
    ...(chimney
      ? {
          chimney: {
            x: chimney[0],
            y: chimney[1],
            puffs: 5,
            spread: 0.8,
            phase: p.W2 % 7,
          },
        }
      : {}),
    paint: (g, s) => paintBuilding(g, s, p),
    animate: (g, s) => animateBuilding(g, s, p),
  };
}

function animateBuilding(g: Ctx2D, s: PaintState, p: Plan): void {
  if (p.cat === "play") {
    // the swing sways a little
    const x = propsAnchor(p) + p.side * 22;
    const a = Math.sin(s.t * 1.6) * 0.25;
    g.save();
    g.translate(x, -10);
    g.rotate(a);
    g.strokeStyle = "#6e5a46";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-5, 0);
    g.lineTo(-5, 30);
    g.moveTo(5, 0);
    g.lineTo(5, 30);
    g.stroke();
    g.fillStyle = "#7b6549";
    g.fillRect(-8, 29, 16, 3);
    ink(g, 0.8);
    g.strokeRect(-8, 29, 16, 3);
    g.restore();
  }
  if (s.open) spill(g, 30, 0.45);
}
