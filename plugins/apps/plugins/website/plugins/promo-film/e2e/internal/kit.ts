// The film's own building blocks over media/film: a Scene (what one section
// contributes — layers, camera keys, sound), the camera-key merge, the click
// level, and the website theme's colours the end card wears.

import type {
  Key,
  Layer,
  PlacedClip,
  SfxCue,
  Vec2,
} from "@plugins/media/plugins/film/e2e";
import { H, W } from "./session-kit";

export { H, W };
export const CENTER: Vec2 = [W / 2, H / 2];

/**
 * The real mouse click's level (× the engine's CLICK_PEAK_DBFS): clearly heard
 * over this film's busy music, still well under it (about -10 dBFS peaks
 * against a -16 LUFS bed).
 */
export const CLICK_GAIN = 2.2;

/** The website theme (apps/website/shell theme.ts). */
export const SITE = {
  bg: "oklch(0.1398 0.0117 265.76)",
  fg: "oklch(0.9674 0.0013 286.38)",
  muted: "oklch(0.7727 0.0127 286.10)",
  azure: "oklch(0.5461 0.2152 262.88)",
  cyan: "oklch(0.7971 0.1339 211.53)",
} as const;

export interface CamKeys {
  focus?: Key<Vec2>[];
  zoom?: Key[];
  tiltX?: Key[];
  tiltY?: Key[];
  roll?: Key[];
}

/** What one section adds to the film. Times are absolute film seconds. */
export interface Scene {
  /** Drawn under every other scene's layers (in scene order). */
  underlay?: Layer[];
  layers: Layer[];
  overlay?: Layer[];
  cam?: CamKeys;
  sfx?: SfxCue[];
  clips?: PlacedClip[];
}

export const fadeInOut = (t: number, d: number, t2: number, d2 = d): Key[] => [
  [t, 0],
  [t + d, 1, "inOutSine"],
  [t2, 1],
  [t2 + d2, 0, "inOutSine"],
];

/** Concatenate scenes' camera keys per property, ordered by time (stable for equal times). */
export function mergeCam(scenes: Scene[]): Required<CamKeys> {
  const out: Required<CamKeys> = {
    focus: [],
    zoom: [],
    tiltX: [],
    tiltY: [],
    roll: [],
  };
  for (const s of scenes) {
    for (const k of Object.keys(out) as (keyof CamKeys)[]) {
      const keys = s.cam?.[k];
      if (keys)
        (out[k] as Key<number | Vec2>[]).push(
          ...(keys as Key<number | Vec2>[]),
        );
    }
  }
  for (const k of Object.keys(out) as (keyof CamKeys)[]) {
    const arr = out[k] as Key<number | Vec2>[];
    const sorted = arr
      .map((key, i) => ({ key, i }))
      .sort((a, b) => a.key[0] - b.key[0] || a.i - b.i)
      .map((e) => e.key);
    (out[k] as Key<number | Vec2>[]) = sorted;
  }
  return out;
}
