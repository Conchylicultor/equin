/**
 * The shared time axis every journey is drawn on: log-scaled, so a 5-second
 * bounce and a 2-hour visit both stay readable while length still says who
 * stayed longest. One axis for the whole loaded window, so rows compare.
 */

/** The log's knee, in seconds: below it the axis is nearly linear. */
const LOG_K = 4;
/** The axis never ends before an hour, so a short window keeps its proportions. */
export const AXIS_MIN_MAX_S = 3600;

/** The axis' far end for a window whose longest visit lasted `longestS`. */
export function axisMaxS(longestS: number): number {
  return Math.max(longestS, AXIS_MIN_MAX_S);
}

/** Where `s` seconds land on an axis ending at `maxS`, as a fraction 0..1. */
export function axisFrac(s: number, maxS: number): number {
  if (s <= 0) return 0;
  return Math.min(1, Math.log1p(s / LOG_K) / Math.log1p(maxS / LOG_K));
}

export interface AxisTick {
  s: number;
  label: string;
}

const TICKS: readonly AxisTick[] = [
  { s: 0, label: "0" },
  { s: 10, label: "10s" },
  { s: 30, label: "30s" },
  { s: 60, label: "1m" },
  { s: 300, label: "5m" },
  { s: 900, label: "15m" },
  { s: 3600, label: "1h" },
  { s: 7200, label: "2h" },
];

/** The axis' labelled ticks up to `maxS`. */
export function axisTicks(maxS: number): readonly AxisTick[] {
  return TICKS.filter((t) => t.s <= maxS);
}

/** Room a tick's label takes on the axis, in px (its caption, plus a gap). */
export const TICK_LABEL_PX = 32;

/**
 * The ticks whose labels fit an axis `widthPx` wide: walking from 0, a tick
 * is kept only when it stands at least {@link TICK_LABEL_PX} past the last
 * kept one — and the last tick (the axis' end) wins over the one before it,
 * so a narrow axis still says how far it reaches.
 */
export function labelledTicks(
  maxS: number,
  widthPx: number,
): readonly AxisTick[] {
  const ticks = axisTicks(maxS);
  const x = (t: AxisTick) => axisFrac(t.s, maxS) * widthPx;
  const kept: AxisTick[] = [];
  for (const t of ticks) {
    const last = kept.at(-1);
    if (last === undefined || x(t) - x(last) >= TICK_LABEL_PX) kept.push(t);
  }
  const end = ticks.at(-1);
  if (end !== undefined && kept.at(-1) !== end) {
    while (kept.length > 1 && x(end) - x(kept.at(-1)!) < TICK_LABEL_PX)
      kept.pop();
    if (kept.length === 0 || x(end) - x(kept.at(-1)!) >= TICK_LABEL_PX)
      kept.push(end);
  }
  return kept;
}

/**
 * How a journey's pages share its bar: the bar's whole length is the visit's
 * total time ON THE AXIS (log), and inside it each page takes its share of the
 * visit linearly — mapping each page through the log would squeeze every late
 * page into a sliver. Fractions of the bar, in page order, summing to 1.
 */
export function pageShares(durationsS: readonly number[]): number[] {
  const total = durationsS.reduce((a, d) => a + Math.max(0, d), 0);
  if (total <= 0) return durationsS.map(() => 1 / durationsS.length);
  return durationsS.map((d) => Math.max(0, d) / total);
}
