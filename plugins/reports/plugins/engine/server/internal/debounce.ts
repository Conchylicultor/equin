// Per-key emit gate for report callers that sit on a hot loop.
//
// Some conditions worth a report are PERSISTENT, not transient: a machine-wide
// Claude daemon lending a spare process into a pane's subtree stays true for as
// long as that spare lives. A caller that observes such a condition once per
// poller tick (1 Hz per live pane) would upsert the same report row every
// second forever — an alarm that fires continuously is an alarm that is off,
// and the row's `count` then measures ticks rather than occurrences.
//
// This is the gate that goes in FRONT of `recordReport` for those callers. It
// is deliberately dependency-free (the `velocity.ts` shape): the decision is
// pure, so it is unit-testable without a database.

/**
 * The default debounce window: one report per key per 5 minutes.
 *
 * Chosen to match the cadence of the monitors that would otherwise be reading
 * these rows — `debug/session-divergence` files on a 5-minute rhythm, and
 * transcript-watcher's foreign-session channel has used the same window since
 * it was written. A persistent condition therefore shows up as ~12 occurrences
 * an hour, which reads as "still happening" without drowning the row.
 */
export const DEFAULT_REPORT_DEBOUNCE_MS = 5 * 60 * 1000;

export interface ReportDebounce {
  /**
   * True when `key` has not been emitted within `windowMs` — and records this
   * instant as its last emission. False means the caller must drop the report.
   */
  admit: (key: string, windowMs: number, now?: number) => boolean;
  /** Live key count. For tests asserting that the sweep actually reclaims. */
  size: () => number;
}

export function createReportDebounce(): ReportDebounce {
  // Bounded by the number of distinct keys seen inside one window, which is
  // zero on a healthy process. The key space is open-ended (pane ids,
  // conversation ids, session ids) and the process is long-lived, so the map is
  // swept on every admission rather than left to grow with the machine's
  // history.
  const lastEmittedAt = new Map<string, number>();

  function sweep(now: number, windowMs: number): void {
    for (const [k, at] of lastEmittedAt) {
      if (now - at >= windowMs) lastEmittedAt.delete(k);
    }
  }

  return {
    admit(key, windowMs, now = Date.now()) {
      const last = lastEmittedAt.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      sweep(now, windowMs);
      lastEmittedAt.set(key, now);
      return true;
    },
    size: () => lastEmittedAt.size,
  };
}
