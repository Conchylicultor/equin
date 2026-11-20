// Every duration the watchdog JUDGES is awake time.
//
// A sleeping Mac runs no job, but the wall clock keeps going: every scheduled
// row that came due during a 15-minute nap is "15 minutes overdue" the instant
// the machine wakes, every slot locked across the nap is "held 15 minutes", and
// a candidate opened just before the nap has "not moved for 15 minutes". None
// of that is the queue's doing — nothing could run. On 2026-11-20 that filed
// `queue-backlog` five times in an hour, each ~0.4 s after a wake
// (report-1795136339-969ygo), while the queue read 0 ready minutes later.
//
// So the watchdog measures a span the way `checkSlotHogs` already did and the
// jobs plugin's own deadline does: its wall-clock length less the sleep this
// process saw inside it. The burst that came due during a nap therefore starts
// its overdue clock at the wake, and gets exactly the drain time a burst that
// came due while awake gets — no wake-specific grace, no suppression, and a
// real backlog (awake, not draining) trips at the same threshold as before.
//
// Pure, with the sleep reading passed in, so the judgment is testable; the
// watchdog supplies `sleptDuring` from `infra/host/machine-sleep`, which is
// `null` where the platform cannot tell — read as "no sleep", i.e. the wall
// clock, the behaviour before this file.

/** The awake part of a span that `sleptMs` of sleep fell inside (never below 0). */
export function awakeMs(wallMs: number, sleptMs: number | null): number {
  return Math.max(0, Math.round(wallMs - (sleptMs ?? 0)));
}

export interface BacklogFacts {
  readyCount: number;
  lockedCount: number;
  /** Wall-clock age of the oldest ready row past its `run_at`. */
  oldestOverdueMs: number;
  /** Sleep this process saw inside that age; `null` = the platform cannot tell. */
  sleptMs: number | null;
}

export interface BacklogThresholds {
  backlogDepthThreshold: number;
  oldestOverdueMinutes: number;
}

export interface BacklogJudgment {
  readyCount: number;
  lockedCount: number;
  oldestOverdueMs: number;
  oldestAwakeOverdueMs: number;
  stalled: boolean;
}

/**
 * Queue depth/stall, judged on AWAKE overdue time. Trips on depth or on the
 * oldest ready row having waited past the threshold while the machine was
 * awake; `stalled` = that, with nothing running. `null` when healthy.
 */
export function judgeBacklog(
  f: BacklogFacts,
  t: BacklogThresholds,
): BacklogJudgment | null {
  const oldestAwakeOverdueMs = awakeMs(f.oldestOverdueMs, f.sleptMs);
  const overdue = oldestAwakeOverdueMs > t.oldestOverdueMinutes * 60_000;
  const tripped = f.readyCount > t.backlogDepthThreshold || overdue;
  if (!tripped) return null;
  return {
    readyCount: f.readyCount,
    lockedCount: f.lockedCount,
    oldestOverdueMs: f.oldestOverdueMs,
    oldestAwakeOverdueMs,
    stalled: f.lockedCount === 0 && overdue,
  };
}

// How far the derived head-of-queue timestamp may drift between two samples and
// still count as "the same row is still at the head". The head's `run_at` is
// derived as `sampleWallClock - oldestOverdueMs`, so it carries this backend's
// clock skew against Postgres (constant between samples, therefore cancelling)
// plus per-query latency (tens of ms, occasionally more under load). One second
// swallows the jitter without hiding a real advance: when a class actually
// drains, its readyCount falls, which resets the candidate regardless.
export const HEAD_DRIFT_TOLERANCE_MS = 1_000;

/** The evidence a class's starvation candidate carries between samples. */
export interface StarvationCandidate {
  headRunAtMs: number;
  readyCount: number;
  since: number;
}

export type StarvationStep =
  /** Nothing ready: drop the candidate. */
  | { kind: "clear" }
  /** First sample, or the class moved: (re)open the candidate from here. */
  | { kind: "open"; candidate: StarvationCandidate }
  /** Still frozen, but not for a whole window of AWAKE time yet. */
  | { kind: "wait" }
  /** Frozen for a whole window of awake time. */
  | { kind: "trip"; starvedForMs: number };

/**
 * One sample of one class's starvation test: did its head move, did its depth
 * fall, and — the part sleep could fake — has it been frozen for `windowMs` of
 * AWAKE time. A head that did not move across a nap moved no less than a
 * sleeping machine could move it; only the awake part of the span is evidence.
 */
export function stepClassStarvation(
  prev: StarvationCandidate | undefined,
  sample: { readyCount: number; oldestOverdueMs: number },
  nowMs: number,
  windowMs: number,
  sleptDuring: (startMs: number, endMs: number) => number | null,
): StarvationStep {
  if (sample.readyCount === 0) return { kind: "clear" };
  const headRunAtMs = nowMs - sample.oldestOverdueMs;
  const headFrozen =
    prev !== undefined &&
    Math.abs(headRunAtMs - prev.headRunAtMs) <= HEAD_DRIFT_TOLERANCE_MS;
  const drained = prev !== undefined && sample.readyCount < prev.readyCount;
  if (!prev || !headFrozen || drained)
    return {
      kind: "open",
      candidate: { headRunAtMs, readyCount: sample.readyCount, since: nowMs },
    };
  const starvedForMs = awakeMs(
    nowMs - prev.since,
    sleptDuring(prev.since, nowMs),
  );
  return starvedForMs < windowMs
    ? { kind: "wait" }
    : { kind: "trip", starvedForMs };
}
