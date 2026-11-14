// Plan-derived geometry shared by painting and the declared footprint, so the
// two cannot drift apart: wall heights, the lean-to, the window slots, the
// roof's key lines, where the props and the sign stand.

import type { Box } from "../spec";
import type { Pt } from "./draw";
import type { Plan, RoofForm, Wall } from "./plan";

export const isRound = (p: Plan): boolean =>
  p.arch === "tower" || p.arch === "hut";

/** Height of the walls (tower: the whole shaft; hut: the drum under the dome). */
export function wallHeight(p: Plan): number {
  return isRound(p)
    ? p.arch === "tower"
      ? p.towerH
      : 48
    : p.storeys === 2
      ? 96
      : 60;
}

export const doorHeight = (p: Plan): number =>
  p.arch === "tower" ? 40 : p.arch === "hut" ? 36 : 42;

/** The storehouse has wide double doors instead of a door (width 0). */
export const doorWidth = (p: Plan): number =>
  p.arch === "storehouse" ? 0 : 22;

/** The soft cast shadow polygon on the ground beside the body. */
export function shadowPts(p: Plan): Pt[] {
  const { W2 } = p;
  const wallH = wallHeight(p);
  const WT = -wallH;
  return isRound(p)
    ? [
        [-W2 + 6, 3],
        [W2, 3],
        [W2 + 36, 18],
        [W2 + 22, Math.max(WT * 0.3, -50)],
        [W2, Math.max(WT * 0.4, -60)],
      ]
    : [
        [-W2 + 6, 3],
        [W2, 3],
        [W2 + 34, 18],
        [W2 + 20, -wallH * 0.45],
        [W2, -wallH * 0.6],
      ];
}

export interface Annex {
  readonly x0: number;
  readonly x1: number;
  /** Wall height. */
  readonly h: number;
  /** The wall material (a workshop's bay is open; logs become planks there). */
  readonly wall: Wall;
  /** The lean-to roof polygon. */
  readonly roof: Pt[];
}

/** The lean-to beside the body, or null. */
export function annexOf(p: Plan): Annex | null {
  const a = p.annex;
  if (!a) return null;
  const wallH = wallHeight(p);
  const x0 = a < 0 ? -p.W2 - p.annexW : p.W2 - 4;
  const x1 = a < 0 ? -p.W2 + 4 : p.W2 + p.annexW;
  const h = Math.round(wallH * 0.62);
  const lo = a < 0 ? x0 - 8 : x1 + 8;
  const hi = a < 0 ? x1 : x0;
  const roof: Pt[] =
    a < 0
      ? [
          [lo, -h + 4],
          [hi, -h + 4],
          [hi, -h - 22],
          [lo + 6, -h - 12],
        ]
      : [
          [hi, -h + 4],
          [lo, -h + 4],
          [lo - 6, -h - 12],
          [hi, -h - 22],
        ];
  const wall: Wall =
    p.arch === "workshop" && p.wall === "logs" ? "planks" : p.wall;
  return { x0, x1, h, wall, roof };
}

export interface WindowSlot {
  /** Left edge of the opening. */
  readonly x: number;
  /** Bottom of the opening. */
  readonly y: number;
  readonly h: number;
}

/** The window count per side of the door. */
export const windowsPerSide = (W2: number): number =>
  Math.max(1, Math.round((W2 * 2 - 40) / 46));

/** The windows of a rectangular body: the ground-floor row, then the upper row. */
export function windowSlots(p: Plan): WindowSlot[] {
  const WT = -wallHeight(p);
  const nW = windowsPerSide(p.W2);
  const out: WindowSlot[] = [];
  const row = (yb: number, h: number) => {
    for (let i = 0; i < nW * 2; i++) {
      const side = i < nW ? -1 : 1;
      const k = i % nW;
      const wx = side * (24 + 14 + k * 46) - 12;
      if (Math.abs(wx + 12) + 14 > p.W2 - 4) continue;
      out.push({ x: wx, y: yb, h });
    }
  };
  row(-20, 26);
  if (p.storeys === 2) row(WT / 2 - 10, 24);
  return out;
}

/** The roof of a rectangular body over x ∈ [x0, x1] whose eave is at `eaveY`. */
export interface RoofShape {
  readonly form: RoofForm;
  readonly x0: number;
  readonly x1: number;
  readonly eaveY: number;
  readonly W: number;
  readonly cx: number;
  /** Eave overhang. */
  readonly ov: number;
  /** Roof rise. */
  readonly rh: number;
  /** Ridge y. */
  readonly top: number;
  /** Hip inset of the ridge at each end. */
  readonly inset: number;
  /** Gable-front: the gable's height, the roof's depth, the gable apex. */
  readonly gh: number;
  readonly D: number;
  readonly ax: number;
  readonly ay: number;
  /** Gambrel: the knee. */
  readonly kneeY: number;
  readonly k: number;
  /** The ridge cap's extent. */
  readonly ra: number;
  readonly rb: number;
  /** Where the chimney stands on the roof. */
  readonly chimX: number;
  readonly chimY: number;
  /** The highest ink the roof reaches. */
  readonly topY: number;
  readonly dormers: readonly { readonly dx: number; readonly dy: number }[];
}

export function roofShape(
  p: Plan,
  x0: number,
  x1: number,
  eaveY: number,
): RoofShape {
  const W = x1 - x0;
  const cx = (x0 + x1) / 2;
  const ov = 12;
  const rh = Math.round(W * (p.roof === "thatch" ? 0.42 : 0.36));
  const top = eaveY - rh;
  const gh = Math.round(W * 0.34);
  const D = Math.round(rh * 0.9);
  const ay = eaveY - gh;
  let inset = 4;
  if (p.roofForm === "hip") inset = W * 0.3;
  if (p.roofForm === "halfhip") inset = W * 0.14;
  const gambrel = p.roofForm === "gambrel";
  const dormers: { dx: number; dy: number }[] = [];
  for (let i = 0; i < p.dormers; i++) {
    dormers.push({
      dx:
        p.dormers === 1
          ? cx + (p.chimney ? -p.chimney * W * 0.12 : 0)
          : cx + (i ? 1 : -1) * W * 0.22,
      dy: eaveY - rh * 0.3,
    });
  }
  const front = p.roofForm === "gablefront";
  return {
    form: p.roofForm,
    x0,
    x1,
    eaveY,
    W,
    cx,
    ov,
    rh,
    top,
    inset,
    gh,
    D,
    ax: cx,
    ay,
    kneeY: eaveY - rh * 0.45,
    k: W * 0.1,
    ra: gambrel ? x0 + W * 0.1 + 6 : x0 + inset,
    rb: gambrel ? x1 - W * 0.1 - 6 : x1 - inset,
    chimX: front ? cx + p.chimney * W * 0.28 : cx + p.chimney * W * 0.3,
    chimY: front ? eaveY - gh * 0.4 - D * 0.6 : eaveY - rh * 0.55,
    topY: front ? ay - 6 - D : top - 5,
    dormers,
  };
}

/** The chimney's smoke anchor (the chimney's mouth), or null when the building has none. */
export function smokeAnchor(p: Plan): Pt | null {
  if (isRound(p) || !p.chimney) return null;
  const R = roofShape(p, -p.W2, p.W2, -wallHeight(p));
  return [R.chimX, R.chimY - 34 - 6];
}

/** The side anchor props stand at (outside the wall, past a lean-to on that side). */
export const propsAnchor = (p: Plan): number =>
  p.side * (p.W2 + (p.annex === p.side ? p.annexW : 0) + 14);

/** The `bounds` box of the grain pass: everything the building paints, with slack. */
export function grainBox(p: Plan): Box {
  const half = p.maxW / 2;
  const wallH = p.arch === "hut" ? 48 : wallHeight(p);
  const top =
    p.arch === "tower"
      ? -(p.towerH + p.W2 * 1.5 + 60)
      : p.arch === "hut"
        ? -(wallH + p.W2 * 1.05 + 60)
        : -(wallH + p.W2 * 2 * 0.42 + 70);
  return [-half - 30, Math.round(top) - 20, half + 50, 46];
}
