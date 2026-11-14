// The pose: joint angles for a walk phase or the idle breath; shared by every view.

import type { Look } from "./looks";
import { TAU } from "./draw-parts";

/** What the figure is doing: a walk phase p in [0,1), or an idle breath b in [0,1) with a blink and a gaze. */
export type FigurePose =
  | {
      readonly mode: "walk";
      readonly p: number;
      readonly blink: false;
      readonly gaze: 0;
    }
  | {
      readonly mode: "idle";
      readonly b: number;
      readonly blink: boolean;
      readonly gaze: number;
    };

export interface Gait {
  readonly legs: readonly { readonly th: number; readonly kn: number }[];
  readonly arms: readonly { readonly a: number; readonly el: number }[];
  readonly breath: number;
  readonly sway: number;
  readonly lag: number;
  readonly hairLag: number;
  readonly twist: number;
}

export function gait(L: Look, pose: FigurePose): Gait {
  const sw = L.swing;
  const st = L.stride ?? 1;
  if (pose.mode === "idle") {
    const b = Math.sin(pose.b * TAU);
    return {
      legs: [
        { th: 0.03, kn: 0.06 },
        { th: -0.03, kn: 0.06 },
      ],
      arms: [
        { a: 0.05 + b * 0.015, el: 0.18 },
        { a: -0.02 - b * 0.015, el: 0.2 },
      ],
      breath: b,
      sway: Math.sin(pose.b * TAU * 0.5) * 0.3,
      lag: 0,
      hairLag: b * 0.15,
      twist: 0,
    };
  }
  const p = pose.p;
  const leg = (q: number) => {
    const c = Math.cos(q * TAU);
    return {
      th: 0.46 * st * Math.sin(q * TAU),
      kn: 0.07 + 0.95 * st * Math.pow(Math.max(0, c), 2),
    };
  };
  const arm = (q: number) => ({
    a: -0.48 * sw * Math.sin(q * TAU),
    el: 0.22 + 0.42 * sw * Math.max(0, -Math.sin(q * TAU)),
  });
  return {
    legs: [leg(p), leg(p + 0.5)],
    arms: [arm(p), arm(p + 0.5)],
    breath: 0,
    sway: Math.sin(p * TAU),
    lag: Math.sin((p - 0.12) * TAU * 2),
    hairLag: Math.sin((p - 0.15) * TAU * 2),
    twist: Math.sin(p * TAU),
  };
}
