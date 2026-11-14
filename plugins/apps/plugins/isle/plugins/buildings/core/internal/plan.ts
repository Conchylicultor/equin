// The plan of a generated building: every choice (archetype, walls, roof,
// chimney, porch, props side…) made once from a seeded stream, so painting only
// executes it. The order of the random draws below is part of the contract —
// the same seed must keep producing the same building.

import type { AppCategory } from "@plugins/primitives/plugins/pane/core";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import { at, type Rnd } from "./colour";

export type Arch =
  "cottage" | "house" | "hall" | "storehouse" | "workshop" | "tower" | "hut";
export type Wall =
  "rubble" | "ashlar" | "plaster" | "planks" | "logs" | "timber";
export type RoofKind = "slate" | "tile" | "shingle" | "thatch";
export type RoofForm = "gable" | "gablefront" | "halfhip" | "hip" | "gambrel";
export type Porch = "none" | "awning" | "porch" | "hood";
export type SizeClass = "s" | "m" | "l";
type Sign = -1 | 1;
type Side = -1 | 0 | 1;

/** The size class of a seed: the max footprint width is s 150 · m 200 · l 240. */
export const SIZE_CLASSES = [
  "m",
  "s",
  "l",
  "m",
  "l",
] as const satisfies readonly SizeClass[];

export const MAX_WIDTH: Readonly<Record<SizeClass, number>> = {
  s: 150,
  m: 200,
  l: 240,
};

export interface Plan {
  readonly arch: Arch;
  readonly cat: AppCategory;
  /** Max footprint width. */
  readonly maxW: number;
  readonly wall: Wall;
  readonly roof: RoofKind;
  readonly storeys: 1 | 2;
  readonly roofForm: RoofForm;
  /** Half the body width. */
  readonly W2: number;
  /** A lean-to on this side (0: none). */
  readonly annex: Side;
  readonly annexW: number;
  /** The chimney's side (0: none). */
  readonly chimney: Side;
  readonly dormers: 0 | 1 | 2;
  readonly porch: Porch;
  readonly arched: boolean;
  readonly winArch: boolean;
  readonly shutters: boolean;
  readonly flowerBoxes: boolean;
  readonly ivy: Side;
  /** Where the props go; the signpost goes on the other side. */
  readonly side: Sign;
  readonly signBracket: Sign;
  readonly shrubs: number;
  readonly wallTone: number;
  readonly towerH: number;
}

const ARCH_MIX: Readonly<
  Record<AppCategory, readonly (readonly [Arch, number])[]>
> = {
  work: [
    ["workshop", 4],
    ["house", 2],
    ["cottage", 1],
    ["storehouse", 1],
  ],
  create: [
    ["cottage", 3],
    ["hut", 2],
    ["house", 2],
    ["workshop", 1],
  ],
  music: [
    ["hall", 3],
    ["hut", 2],
    ["cottage", 1],
    ["tower", 1],
  ],
  life: [
    ["cottage", 4],
    ["house", 3],
    ["hut", 1],
  ],
  data: [
    ["storehouse", 4],
    ["hall", 2],
    ["tower", 1],
  ],
  play: [
    ["hut", 3],
    ["cottage", 2],
    ["house", 1],
  ],
  system: [
    ["tower", 3],
    ["workshop", 3],
    ["storehouse", 1],
  ],
};

const pick = <T>(r: Rnd, arr: readonly T[]): T =>
  at(arr, (r() * arr.length) | 0);

function weightedPick<T>(r: Rnd, table: readonly (readonly [T, number])[]): T {
  let tot = 0;
  for (const [, w] of table) tot += w;
  let x = r() * tot;
  for (const [k, w] of table) {
    x -= w;
    if (x <= 0) return k;
  }
  return at(table, 0)[0];
}

/** Plans the building of a seed, for an app of this category. */
export function planBuilding(
  seed: number,
  cat: AppCategory,
  size: SizeClass,
): Plan {
  const r = mulberry32(seed);
  const maxW = MAX_WIDTH[size];
  let arch = weightedPick(r, ARCH_MIX[cat]);
  if (maxW < 170 && (arch === "storehouse" || arch === "hall")) {
    arch = r() < 0.5 ? "cottage" : "tower";
  }
  const wallRound = arch === "tower" || arch === "hut";
  const wall: Wall = wallRound
    ? pick<Wall>(r, ["rubble", "ashlar", "plaster"])
    : pick<Wall>(
        r,
        arch === "storehouse"
          ? ["planks", "logs", "timber", "rubble"]
          : [
              "rubble",
              "ashlar",
              "timber",
              "logs",
              "planks",
              "timber",
              "rubble",
            ],
      );
  const roof: RoofKind =
    arch === "hut"
      ? "thatch"
      : arch === "tower"
        ? pick<RoofKind>(r, ["slate", "shingle", "slate"])
        : pick<RoofKind>(r, [
            "slate",
            "tile",
            "shingle",
            "thatch",
            "slate",
            "tile",
          ]);
  const storeys =
    arch === "house" ? 2 : arch === "hall" ? (r() < 0.4 ? 2 : 1) : 1;
  let roofForm: RoofForm =
    arch === "storehouse"
      ? pick<RoofForm>(r, ["gambrel", "halfhip", "gable"])
      : arch === "hall"
        ? pick<RoofForm>(r, ["hip", "halfhip"])
        : arch === "house"
          ? pick<RoofForm>(r, ["gable", "gablefront", "hip"])
          : pick<RoofForm>(r, ["gable", "gable", "halfhip", "gablefront"]);
  if (roof === "thatch" && roofForm === "gambrel") roofForm = "halfhip";
  // body size
  const frac = wallRound
    ? arch === "tower"
      ? 0.42 + r() * 0.1
      : 0.62 + r() * 0.12
    : arch === "workshop"
      ? 0.52 + r() * 0.1
      : 0.66 + r() * 0.16;
  const W2 = Math.round((maxW * frac) / 2);
  let annex: Side =
    arch === "workshop"
      ? r() < 0.5
        ? -1
        : 1
      : (arch === "cottage" || arch === "storehouse") && r() < 0.25
        ? r() < 0.5
          ? -1
          : 1
        : 0;
  const annexW = annex ? Math.round(Math.min(maxW / 2 - W2 - 4, W2 * 0.7)) : 0;
  if (annex && annexW < 26) annex = 0;
  const chimney: Side =
    roof !== "thatch" || r() < 0.4
      ? r() < 0.75
        ? r() < 0.5
          ? -1
          : 1
        : 0
      : 0;
  const dormers =
    storeys === 1 &&
    (roofForm === "gable" || roofForm === "halfhip") &&
    roof !== "thatch" &&
    r() < 0.45
      ? r() < 0.5
        ? 1
        : 2
      : 0;
  const porch = pick<Porch>(r, ["none", "awning", "porch", "none", "hood"]);
  const arched = wall === "rubble" || wall === "ashlar" ? r() < 0.6 : r() < 0.2;
  const winArch = (wall === "ashlar" || arch === "hall") && r() < 0.6;
  const shutters =
    (wall === "timber" || wall === "plaster" || wall === "rubble") &&
    r() < 0.45;
  const flowerBoxes = cat === "life" ? r() < 0.8 : r() < 0.15;
  const ivy: Side =
    (wall === "rubble" || wall === "ashlar") && r() < 0.45
      ? r() < 0.5
        ? -1
        : 1
      : 0;
  const side: Sign = r() < 0.5 ? -1 : 1;
  const signBracket: Sign = r() < 0.5 ? -1 : 1;
  const shrubs = 1 + ((r() * 3) | 0);
  const wallTone = r();
  const towerH = 120 + ((r() * 30) | 0);
  return {
    arch,
    cat,
    maxW,
    wall,
    roof,
    storeys,
    roofForm,
    W2,
    annex,
    annexW,
    chimney,
    dormers,
    porch,
    arched,
    winArch,
    shutters,
    flowerBoxes,
    ivy,
    side,
    signBracket,
    shrubs,
    wallTone,
    towerH,
  };
}
