// The host idle state machine, pure: what the host is now, given what it was
// and what every blocker says. The evaluate job (server) is its only caller;
// it owns the reads, the row and the timers, this owns the rule.

/** How long every blocker must stay quiet before the host counts as idle. */
export const IDLE_SUSTAIN_MS = 10 * 60_000;

/**
 * `busy` — some blocker is busy. `settling` — every blocker is quiet, not yet
 * for `IDLE_SUSTAIN_MS`. `idle` — every blocker has been quiet that long.
 */
export const HOST_IDLE_STATES = ["busy", "settling", "idle"] as const;
export type HostIdleState = (typeof HOST_IDLE_STATES)[number];

/** What one blocker says, as `IdleBlocker.read()` answers it. */
export interface IdleBlockerReading {
  /** Something it watches is working: the host is not idle. */
  busy: boolean;
  /** What it sees, in words — "3 agents working", "no op running". */
  label: string;
  /**
   * When its answer may change WITHOUT any event saying so (a lease that
   * lapses on the clock), epoch ms: the evaluation runs again then. `null`
   * when every change it can make is announced.
   */
  recheckAt: number | null;
}

/** One blocker's reading, under its id. */
export interface BlockerReading extends IdleBlockerReading {
  id: string;
}

/** The persisted state between two evaluations. */
export interface HostIdleRecord {
  state: HostIdleState;
  /** Since when every blocker has been quiet; `null` while busy. */
  quietSince: number | null;
  /** Since when the host has been idle; `null` unless idle. */
  idleSince: number | null;
}

export interface IdleStep {
  next: HostIdleRecord;
  /** The host just became idle (`began`) or stopped being idle (`ended`). */
  transition: "began" | "ended" | null;
  /**
   * When the evaluation must run again with no event to wake it: the end of
   * the sustain window while settling, or the earliest blocker recheck.
   * `null` when only an event can change the answer.
   */
  wakeAt: number | null;
}

/**
 * The next state. `prev` is `null` before the first evaluation, which reads
 * as busy: the sustain window starts at the first quiet evaluation, so a
 * restart of main never makes the host idle sooner than 10 min of observed
 * quiet.
 */
export function nextIdleState(
  prev: HostIdleRecord | null,
  readings: readonly BlockerReading[],
  now: number,
): IdleStep {
  const rechecks = readings.flatMap((r) =>
    r.recheckAt === null ? [] : [Math.max(r.recheckAt, now)],
  );
  const earliest = (extra: number | null): number | null => {
    const all = extra === null ? rechecks : [...rechecks, extra];
    return all.length === 0 ? null : Math.min(...all);
  };
  const wasIdle = prev?.state === "idle";

  if (readings.some((r) => r.busy))
    return {
      next: { state: "busy", quietSince: null, idleSince: null },
      transition: wasIdle ? "ended" : null,
      wakeAt: earliest(null),
    };

  const quietSince =
    prev === null || prev.state === "busy" || prev.quietSince === null
      ? now
      : prev.quietSince;
  const sustainEnd = quietSince + IDLE_SUSTAIN_MS;
  if (now < sustainEnd)
    return {
      next: { state: "settling", quietSince, idleSince: null },
      transition: wasIdle ? "ended" : null,
      wakeAt: earliest(sustainEnd),
    };
  return {
    next: {
      state: "idle",
      quietSince,
      idleSince: prev?.state === "idle" ? (prev.idleSince ?? now) : now,
    },
    transition: wasIdle ? null : "began",
    wakeAt: earliest(null),
  };
}
