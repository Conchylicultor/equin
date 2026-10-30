/** A closed wall-clock interval, epoch ms. */
export interface Interval {
  startMs: number;
  endMs: number;
}

/** The ms of `[startMs, endMs]` covered by the UNION of `intervals`. */
export function coveredMs(
  intervals: readonly Interval[],
  startMs: number,
  endMs: number,
): number {
  const clipped = intervals
    .map((i) => ({
      startMs: Math.max(i.startMs, startMs),
      endMs: Math.min(i.endMs, endMs),
    }))
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let frontier = startMs;
  for (const i of clipped) {
    const from = Math.max(i.startMs, frontier);
    if (i.endMs > from) {
      total += i.endMs - from;
      frontier = i.endMs;
    }
  }
  return total;
}

/** Does any interval touch `[startMs, endMs]`? */
export function overlapsAny(
  intervals: readonly Interval[],
  startMs: number,
  endMs: number,
): boolean {
  return intervals.some((i) => i.startMs <= endMs && i.endMs >= startMs);
}

/** Append to a ring bounded at `cap`, dropping the oldest. */
export function pushBounded<T>(ring: T[], item: T, cap: number): void {
  ring.push(item);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
}
