// A building's hit mask: what the pointer hits is its drawn shape, not its
// box — read from its paint's alpha. Pure arithmetic over the RGBA bytes, so a
// bake worker (`bake.worker.ts`) reads it off the page's thread, bit-identical
// to the page's own reading.

import type { Box } from "@plugins/apps/plugins/isle/plugins/buildings/core";

export interface Mask {
  readonly gw: number;
  readonly gh: number;
  readonly raw: Uint8Array;
  readonly bits: Uint8Array;
}

export const MASK_C = 2;
const MASK_A = 90;

export const MASK_DIL = 2;

/** A building's hit mask from its 2× paint's RGBA: max-pooled into cells, loose props dropped, dilated. */
export function maskFromAlpha(
  d: Uint8ClampedArray,
  W: number,
  H: number,
  bounds: Box,
): Mask {
  const s = MASK_C * 2; // the paint is at 2×
  const gw = Math.ceil((bounds[2] - bounds[0]) / MASK_C);
  const gh = Math.ceil((bounds[3] - bounds[1]) / MASK_C);
  const raw = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = ((y / s) | 0) * gw;
    for (let x = 0, i = y * W * 4 + 3; x < W; x++, i += 4)
      if (d[i]! >= MASK_A) raw[row + ((x / s) | 0)] = 1;
  }
  const R = MASK_DIL;
  const offs: [number, number][] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++)
      if (dx * dx + dy * dy <= R * R + R) offs.push([dx, dy]);
  const dilate = (src: Uint8Array) => {
    const out = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++)
        if (src[j * gw + i])
          for (const [dx, dy] of offs) {
            const x = i + dx;
            const y = j + dy;
            if (x >= 0 && y >= 0 && x < gw && y < gh) out[y * gw + x] = 1;
          }
    return out;
  };
  // loose props on the ground (a barrel, a crate) are their own islands of paint: keep only the building
  const near = dilate(raw);
  const lab = new Int32Array(gw * gh);
  const area = [0];
  const stack: number[] = [];
  for (let k = 0; k < gw * gh; k++) {
    if (!near[k] || lab[k]) continue;
    const id = area.length;
    area.push(0);
    lab[k] = id;
    stack.push(k);
    while (stack.length) {
      const q = stack.pop()!;
      const i = q % gw;
      const j = (q / gw) | 0;
      if (raw[q]) area[id]!++;
      const visit = (n: number) => {
        if (near[n] && !lab[n]) {
          lab[n] = id;
          stack.push(n);
        }
      };
      if (i > 0) visit(q - 1);
      if (i < gw - 1) visit(q + 1);
      if (j > 0) visit(q - gw);
      if (j < gh - 1) visit(q + gw);
    }
  }
  const big = Math.max(...area);
  for (let k = 0; k < gw * gh; k++)
    if (raw[k] && area[lab[k]!]! < big * 0.1) raw[k] = 0;
  return { gw, gh, raw, bits: dilate(raw) };
}
