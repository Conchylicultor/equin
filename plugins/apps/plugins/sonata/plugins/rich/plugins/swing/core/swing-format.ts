import type { Swing } from "@plugins/apps/plugins/sonata/plugins/score/core";

/** The range a chosen feel's ratio lives in: straight (1) to past a hard shuffle. */
export const MIN_SWING_RATIO = 1;
export const MAX_SWING_RATIO = 3.5;

/** The feel a song swings with when turned on with no feel of its own. */
export const DEFAULT_SWING: Swing = { unit: 8, ratio: 2 };

export interface SwingStop {
  id: "light" | "triplet" | "hard";
  name: string;
  ratio: number;
}

/** The named feels the ratio control offers as one-click stops. */
export const SWING_STOPS: readonly SwingStop[] = [
  { id: "light", name: "Light", ratio: 1.5 },
  { id: "triplet", name: "Triplet", ratio: 2 },
  { id: "hard", name: "Hard", ratio: 3 },
];

const EPS = 1e-6;

/** The named stop at exactly `ratio`, if any. */
export function swingStopAt(ratio: number): SwingStop | undefined {
  return SWING_STOPS.find((s) => Math.abs(s.ratio - ratio) < EPS);
}

/** `2` → "2:1", `1.5` → "3:2", `1.75` → "1.75:1". */
export function swingRatioLabel(ratio: number): string {
  if (Math.abs(ratio - Math.round(ratio)) < EPS)
    return `${Math.round(ratio)}:1`;
  if (Math.abs(ratio * 2 - Math.round(ratio * 2)) < EPS)
    return `${Math.round(ratio * 2)}:2`;
  return `${Number(ratio.toFixed(2))}:1`;
}

/** What a ratio sounds like, in words. */
export function swingFeelName(ratio: number): string {
  if (ratio < 1.08) return "Straight";
  if (ratio < 1.75) return "Light swing";
  if (ratio < 2.4) return "Triplet swing";
  if (ratio < 3.25) return "Hard swing";
  return "Dotted swing";
}

export function swingUnitLabel(unit: Swing["unit"]): string {
  return unit === 8 ? "8ths" : "16ths";
}

/** "Swing 8ths · 2:1". */
export function swingLabel(swing: Swing): string {
  return `Swing ${swingUnitLabel(swing.unit)} · ${swingRatioLabel(swing.ratio)}`;
}

/** How a swung pair splits, in whole percent: 2:1 → [67, 33]. */
export function swingSplit(ratio: number): [number, number] {
  const long = Math.round((ratio / (1 + ratio)) * 100);
  return [long, 100 - long];
}
