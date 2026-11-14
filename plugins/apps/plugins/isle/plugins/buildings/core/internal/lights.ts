// The night glows of a planned building (door-relative `[x, y, radius]`),
// known from the plan alone: windows, the door, a tower's slits.

import type { Light } from "../spec";
import { wallHeight, windowsPerSide } from "./layout";
import type { Plan } from "./plan";

export function estimateLights(p: Plan): Light[] {
  if (p.arch === "tower") {
    const WT = -p.towerH;
    return [
      [0, WT * 0.62 - 9, 10],
      [0, WT * 0.25 - 4, 10],
      [0, -24, 12],
    ];
  }
  if (p.arch === "hut") {
    return [
      [-p.W2 * 0.6, -22, 10],
      [p.W2 * 0.6, -22, 10],
      [0, -24, 12],
    ];
  }
  const L: Light[] = [[0, -24, 12]];
  const nW = windowsPerSide(p.W2);
  for (let i = 0; i < nW * 2; i++) {
    const side = i < nW ? -1 : 1;
    const k = i % nW;
    const wx = side * (38 + k * 46) - 12;
    if (Math.abs(wx + 12) + 14 > p.W2 - 4) continue;
    L.push([wx + 12, -33, 12]);
    if (p.storeys === 2) L.push([wx + 12, -70, 12]);
  }
  // a storehouse's wide doors glow too
  if (p.arch === "storehouse")
    L.push([0, -Math.min(54, wallHeight(p) - 8) / 2, 26]);
  return L;
}
