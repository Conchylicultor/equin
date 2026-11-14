// Equin Isle, the home island: hand-shaped (a lake, a river out of it to an
// estuary on the east coast, a dock in the south), the same whatever the world
// seed. Its river and lake are carved into the land on a coarse grid.

import { segDist, spline, type Pt } from "./geometry";
import { smoothstep, vnoise } from "./noise";

const HS = 1.6;
/** The home island's centre and radii, world px. */
export const HOME_CX = 1600 * HS;
export const HOME_CY = 1230 * HS;
export const HOME_RX = 1240 * HS;
export const HOME_RY = 900 * HS;
/** The extent of the carve grid (the home island's own frame). */
const W0 = 3200 * HS;
const H0 = 2400 * HS;

/** A point in the home island's unit frame (u, v ∈ about [-1, 1]). */
export const homeAt = (u: number, v: number): Pt => [
  HOME_CX + u * HOME_RX,
  HOME_CY + v * HOME_RY,
];

export const HOME_SHAPE_SEED = 3;
export const LAKE = {
  c: homeAt(-0.3, -0.52),
  rx: 170 * HS,
  ry: 115 * HS,
} as const;
/** A narrow wandering stream out of the lake, opening into an estuary on the east coast. */
export const RIVER: readonly Pt[] = spline(
  [
    homeAt(-0.27, -0.45),
    homeAt(-0.2, -0.37),
    homeAt(-0.1, -0.31),
    homeAt(-0.01, -0.21),
    homeAt(0.12, -0.15),
    homeAt(0.24, -0.17),
    homeAt(0.33, -0.09),
    homeAt(0.45, -0.11),
    homeAt(0.56, -0.03),
    homeAt(0.67, -0.06),
    homeAt(0.79, 0.01),
    homeAt(0.92, -0.01),
    homeAt(1.04, 0.01),
    homeAt(1.18, 0.0),
  ],
  12,
);
/** River half-width at fraction a along it, px. */
export const riverWidth = (a: number): number =>
  15 + 13 * vnoise(a * 11, 3.7) + 80 * Math.pow(smoothstep(0.84, 1, a), 1.6);
const riverBank = (a: number) => 1 + 15 * vnoise(a * 17 + 4, 8.1);
const riverDepth = (a: number) =>
  0.06 + 0.035 * vnoise(a * 7, 1.3) + 0.08 * smoothstep(0.82, 1, a);

/** Home's village sites (u, v): the green, a hill village, the harbour, the east cape, the west woods. */
export const HOME_SLOTS: readonly Pt[] = [
  [-0.06, 0.18],
  [0.26, -0.52],
  [-0.6, 0.42],
  [0.64, 0.22],
  [-0.62, -0.16],
];
/** Home's hills: (u, v, radius px, height). */
export const HOME_HILLS: readonly (readonly [
  number,
  number,
  number,
  number,
])[] = [
  [0.34, -0.66, 420, 1],
  [-0.78, -0.34, 340, 0.8],
  [0.74, 0.5, 280, 0.6],
];
/** Where the root road starts, by the dock. */
export const DOCK_ROOT: Pt = homeAt(-0.5, 0.72);

let carveGrid: Float32Array | null = null;
let carveFn: ((x: number, y: number) => number) | null = null;

/** The river and lake carved into the home island: a height cap at (x, y), world px. */
export function homeCarve(x: number, y: number): number {
  carveFn ??= carveOf((carveGrid ??= buildCarveGrid()));
  return carveFn(x, y);
}

/**
 * The carve's grid (built on first call): a pure function of the home
 * island's hand-placed river and lake, so a bake worker can build it and the
 * page {@link adoptHomeCarve} it.
 */
export function homeCarveGrid(): Float32Array {
  carveGrid ??= buildCarveGrid();
  return carveGrid;
}

/** Whether the carve's grid is in (built or adopted): reading the carve costs nothing. */
export function homeCarveBuilt(): boolean {
  return carveGrid !== null;
}

/** The carve's grid built elsewhere (identical to {@link homeCarveGrid}'s); ignored once there is one. */
export function adoptHomeCarve(grid: Float32Array): void {
  if (carveGrid) return;
  if (grid.length !== CARVE_W * CARVE_H)
    throw new Error(
      `isle home carve: a grid of ${grid.length} cells, not ${CARVE_W * CARVE_H}`,
    );
  carveGrid = grid;
}

const CG = 8;
const CARVE_W = W0 / CG + 1;
const CARVE_H = H0 / CG + 1;

function buildCarveGrid(): Float32Array {
  const cgW = CARVE_W;
  const cgH = CARVE_H;
  const grid = new Float32Array(cgW * cgH);
  // beyond ~225 px of the river the carve is flat ground anyway: a coarse mask skips the distance there
  const RM = 64;
  const rmW = Math.ceil(W0 / RM) + 1;
  const riverNear = new Uint8Array(rmW * (Math.ceil(H0 / RM) + 1));
  for (let i = 1; i < RIVER.length; i++) {
    const [ax, ay] = RIVER[i - 1]!;
    const [bx, by] = RIVER[i]!;
    const L = Math.hypot(bx - ax, by - ay);
    for (let t = 0; t <= L; t += 16) {
      const px = ax + ((bx - ax) * t) / Math.max(L, 1e-6);
      const py = ay + ((by - ay) * t) / Math.max(L, 1e-6);
      for (
        let cj = Math.floor((py - 300) / RM);
        cj <= Math.floor((py + 300) / RM);
        cj++
      ) {
        for (
          let ci = Math.floor((px - 300) / RM);
          ci <= Math.floor((px + 300) / RM);
          ci++
        ) {
          if (
            ci >= 0 &&
            cj >= 0 &&
            ci < rmW &&
            cj * rmW + ci < riverNear.length
          )
            riverNear[cj * rmW + ci] = 1;
        }
      }
    }
  }
  for (let j = 0; j < cgH; j++) {
    for (let i = 0; i < cgW; i++) {
      const x = i * CG;
      const y = j * CG;
      let cr = 1;
      if (riverNear[Math.floor(y / RM) * rmW + Math.floor(x / RM)]) {
        const r = segDist(RIVER, x, y);
        const a = r.i / (RIVER.length - 1);
        const w = riverWidth(a);
        const bank = riverBank(a);
        const dep = riverDepth(a);
        const d = r.d + (vnoise(x / 23, y / 23) - 0.5) * 7;
        cr =
          d < w
            ? -dep * Math.pow(1 - (d / w) * (d / w), 0.7)
            : d < w + bank
              ? ((d - w) / Math.max(bank, 1)) * 0.07
              : 0.07 + ((d - w - bank) / 26) * 0.25;
      }
      const ld =
        Math.hypot((x - LAKE.c[0]) / LAKE.rx, (y - LAKE.c[1]) / LAKE.ry) +
        (vnoise(x / 60, y / 60) - 0.5) * 0.22;
      const dl = (ld - 1) * Math.min(LAKE.rx, LAKE.ry);
      const bl = 2 + 13 * vnoise(x / 50 + 9, y / 50);
      const cl =
        dl < 0
          ? -0.16 * Math.pow(Math.min(1, -dl / 70), 0.7)
          : dl < bl
            ? (dl / bl) * 0.07
            : 0.07 + ((dl - bl) / 26) * 0.25;
      grid[j * cgW + i] = Math.max(Math.min(1, cr, cl), -0.2);
    }
  }
  return grid;
}

function carveOf(grid: Float32Array): (x: number, y: number) => number {
  const cgW = CARVE_W;
  const cgH = CARVE_H;
  return function carve(x, y) {
    if (x < 0 || y < 0 || x > W0 || y > H0) return 1;
    const gx = Math.max(0, Math.min(cgW - 1.001, x / CG));
    const gy = Math.max(0, Math.min(cgH - 1.001, y / CG));
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    const a = grid[j * cgW + i]!;
    const b = grid[j * cgW + i + 1]!;
    const c = grid[(j + 1) * cgW + i]!;
    const d = grid[(j + 1) * cgW + i + 1]!;
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
