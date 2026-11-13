import { AsyncLocalStorage } from "node:async_hooks";
import { installSharedWorkScope } from "@plugins/packages/plugins/shared-work/core";

/**
 * The WALL time a check spends in shared work it happened to start — the
 * other half of `packages/shared-work`'s file-call attribution.
 *
 * Which check of a pass asks first for a shared memo (the enriched plugin
 * tree, the evaluated barrels, the registry context) is an accident of order:
 * in a serial pass that check's `durationMs` held the whole build of it, and
 * the per-check table blamed it — `active-data:document-chip-has-server-token`
 * "cost" 2.2–3.8 s that was the tree's. Every piece of shared work started in
 * a check's async context is timed here, from its start to its settling, and
 * the check's record splits its wall into the part it spent in shared work it
 * started (`sharedMs`, by name) and the rest (its own).
 *
 * Only the OUTERMOST shared work is timed: the producer runs with no unit in
 * its context, so the shared work it starts in turn is inside its interval,
 * never counted twice. A check awaiting shared work ANOTHER check started is
 * still waiting in its own wall — in a serial pass that work has settled
 * before the next check starts, so it waits for nothing.
 */

/** One check's shared-work intervals, as they settle. */
export interface SharedWallMeter {
  readonly intervals: { name: string; start: number; end: number }[];
}

const units = new AsyncLocalStorage<SharedWallMeter | undefined>();

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

installSharedWorkScope((name, fn) => {
  const unit = units.getStore();
  if (unit === undefined) return fn();
  // Open from its start (an end of +Infinity until it settles), so work still
  // running when the check ends is clipped to the check's window.
  const interval = { name, start: performance.now(), end: Infinity };
  unit.intervals.push(interval);
  const done = (): void => {
    interval.end = performance.now();
  };
  // The producer runs outside the unit: shared work it starts is its own.
  const result = units.run(undefined, fn);
  // Both arms settle the interval. The rejection arm marks the producer's
  // promise handled — harmless for a memo, whose promise every asker awaits
  // and gets the rejection from; the caller still receives `result` itself.
  if (isThenable(result)) result.then(done, done);
  else done();
  return result;
});

export function newSharedWallMeter(): SharedWallMeter {
  return { intervals: [] };
}

/** Run `fn` (a check's body) with the shared work it starts timed into `meter`. */
export function withSharedWallMeter<T>(meter: SharedWallMeter, fn: () => T): T {
  return units.run(meter, fn);
}

/**
 * The meter's shared wall within `[from, to]` (a check's window): the union of
 * its intervals clipped to the window — work that outlives the check (started,
 * never awaited) counts only while the check ran — and each name's share, the
 * overlap of two names given to the one that started first.
 */
export function sharedWallWithin(
  meter: SharedWallMeter,
  from: number,
  to: number,
): { totalMs: number; byName: Record<string, number> } {
  const clipped = meter.intervals
    .map((i) => ({
      name: i.name,
      start: Math.max(i.start, from),
      end: Math.min(i.end, to),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const byName: Record<string, number> = {};
  let covered = from;
  let totalMs = 0;
  for (const i of clipped) {
    const start = Math.max(i.start, covered);
    if (i.end <= start) continue;
    const ms = i.end - start;
    totalMs += ms;
    byName[i.name] = (byName[i.name] ?? 0) + ms;
    covered = i.end;
  }
  return { totalMs, byName };
}
