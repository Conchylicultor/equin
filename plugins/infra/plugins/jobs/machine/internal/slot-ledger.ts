import type { Job, WorkerEventMap, WorkerEvents } from "graphile-worker";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { HOLD_CLASSES, holdForTask, type HoldClass } from "../../core/hold";

// THE SLOT LEDGER: which worker slot of which runner is holding which job, right
// now, in this backend — plus how long each class's jobs waited to be picked up.
//
// Nothing in the database can answer the first question. The three runners share
// one job table, and a locked row records only graphile's random `locked_by`
// worker id, never which runner that worker belongs to. The runners are ours,
// though: `startWorkers` hands each one its own event emitter, so an event heard
// on that emitter is known to come from that runner's slots. This file is the
// only place that knowledge is kept.
//
// It hooks graphile's events, NOT a `finally` around `dispatch()`, and the reason
// is ordering. graphile emits `job:complete` only after it has written the
// outcome back (`completeJob` / `failJob` — `dist/worker.js`), so the row is
// already unlocked when the slot leaves the ledger. A `finally` in our handler
// runs BEFORE that write, and would show a slot free while its row is still
// locked — a window in which the ledger and `queryQueuePulse()` disagree about
// the same job.
//
// Process state, like `forfeit.ts`: a slot is a fact about this backend's
// worker pool, and it dies with the process.

/** One worker slot that is holding a job right now. */
export interface OccupiedSlot {
  /** graphile's worker id. The key: one worker is one slot. */
  workerId: string;
  /** Which runner in the ladder the slot belongs to (`floor` / `mid` / `wide`). */
  runnerId: string;
  /** graphile job id. */
  jobId: string;
  /** `payload.jobName`, or `(unknown)` — the same reading as `jobNameExpr`. */
  jobName: string;
  /**
   * The class of the graphile TASK the row was fetched on (`holdForTask`), not
   * the registered job's declared `hold`. The task is what decided which runners
   * could fetch the row, it is what `queryRunningJobs` and `queue-slot-hog`
   * read, and it needs no registry lookup — so it stays exact for a row whose
   * `jobName` this backend does not know. The two differ only for a row still on
   * the legacy task mid-deploy, which reads `minutes` here.
   */
  hold: HoldClass;
  /** When the row became due (epoch ms, database clock). */
  runAt: number;
  /** When graphile's `get_job` locked it (epoch ms, database clock). */
  lockedAt: number;
  /** 1-based attempt number (graphile increments `attempts` in `get_job`). */
  attempt: number;
}

/**
 * How long a class's jobs waited between becoming due and being picked up,
 * over the last {@link PICKUP_WINDOW_MS}.
 *
 * `count: 0` means no job of this class was picked up in the window, and every
 * other field is then `null` — never `0`, which would claim "picked up
 * instantly" about jobs that do not exist.
 */
export interface PickupStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

/** How far back the pickup samples reach. */
export const PICKUP_WINDOW_MS = 15 * 60_000;

/** Most samples kept per class. A burst past this keeps the newest. */
export const PICKUP_SAMPLE_CAP = 1024;

// The notification graphile's `add_job` sends on commit.
const INSERT_CHANNEL = "jobs:insert";

const slots = new Map<string, OccupiedSlot>();

interface PickupSample {
  /** When the sample was taken (epoch ms, this process's clock) — for the window. */
  at: number;
  delayMs: number;
}

// Appended in time order, so the oldest sample is always at the front and both
// the cap and the window evict from there.
const pickupSamples = new Map<HoldClass, PickupSample[]>(
  HOLD_CLASSES.map((hold) => [hold, []]),
);

const activityListeners = new Set<() => void>();

/** Every slot holding a job right now, across every runner of this backend. */
export function getOccupiedSlots(): OccupiedSlot[] {
  return [...slots.values()];
}

/** Pickup-delay percentiles per class over the last {@link PICKUP_WINDOW_MS}.
 * `now` is injectable for tests. */
export function getPickupStats(
  now: number = Date.now(),
): Record<HoldClass, PickupStats> {
  const cutoff = now - PICKUP_WINDOW_MS;
  const out = {} as Record<HoldClass, PickupStats>;
  for (const hold of HOLD_CLASSES) {
    const ring = pickupSamples.get(hold)!;
    while (ring.length > 0 && ring[0]!.at < cutoff) ring.shift();
    out[hold] = summarize(ring.map((s) => s.delayMs));
  }
  return out;
}

// Nearest-rank percentiles: always an observed value, never an interpolation
// between two jobs that each waited something else.
function summarize(delays: number[]): PickupStats {
  if (delays.length === 0) {
    return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...delays].sort((a, b) => a - b);
  const rank = (q: number) =>
    sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    p50Ms: rank(0.5),
    p95Ms: rank(0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

/**
 * Be told when the queue may have changed: a job started or finished in this
 * backend, a row was inserted, or one of this plugin's own mutations touched
 * graphile's tables. It carries no payload — a listener re-reads what it needs.
 * Returns the unsubscribe.
 *
 * Listeners run synchronously inside graphile's event emission, so they must be
 * cheap (a resource `notify()` is the intended shape).
 */
export function onQueueActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

/**
 * Announce queue activity. Called by the ledger's own graphile events and by
 * every queue mutation that sends no notification of its own (cancel, retry,
 * dead-job GC, the stuck-lock reclaim, durable-run teardown).
 *
 * A listener that throws is reported and the rest still run — it is never
 * re-thrown. Most callers are inside graphile's `events.emit(...)`, and graphile
 * does not survive a throwing listener: from `job:start` it would leave the
 * worker holding a job it never runs, from `job:complete` it would take the
 * worker down. One broken listener must not cost a worker slot.
 */
export function emitQueueActivity(): void {
  for (const listener of [...activityListeners]) {
    guarded("queue activity listener", listener);
  }
}

/**
 * Feed the ledger from one runner's events. Must be attached BEFORE `run()`:
 * a runner can start jobs inside `run()`, and a `job:start` heard by nobody is a
 * slot the ledger never frees nor counts.
 *
 * `listenInserts` subscribes to graphile's `jobs:insert` notification. Pass it
 * on exactly one runner: each runner holds its own LISTEN client, so listening
 * on all three would announce every insert three times.
 *
 * Returns a detach function.
 */
export function attachSlotLedger(
  runnerId: string,
  events: WorkerEvents,
  opts: { listenInserts: boolean },
): () => void {
  const onStart = ({ worker, job }: WorkerEventMap["job:start"]): void => {
    guarded("job:start", () => {
      const hold = holdForTask(job.task_identifier);
      const runAt = epochMs(job, "run_at", job.run_at);
      const lockedAt = epochMs(job, "locked_at", job.locked_at);
      slots.set(worker.workerId, {
        workerId: worker.workerId,
        runnerId,
        jobId: String(job.id),
        jobName: jobNameOf(job.payload),
        hold,
        runAt,
        lockedAt,
        attempt: job.attempts,
      });
      // A row in a named queue (a `serial` lane) may have waited for its lane
      // rather than for a slot — by design, and indistinguishably from here.
      // Counting it would charge the class's pickup time with a wait the pickup
      // target does not describe, so only lane-free rows are sampled.
      if (job.job_queue_id === null) {
        recordPickup(hold, lockedAt - runAt);
      }
    });
    emitQueueActivity();
  };
  const onComplete = ({ worker }: WorkerEventMap["job:complete"]): void => {
    slots.delete(worker.workerId);
    emitQueueActivity();
  };
  // The worker failed to write the job's outcome back and is releasing itself
  // ("committing seppuku"). It will never emit `job:complete`, so this is the
  // slot's only exit. The row stays locked until the stuck-lock sweeper
  // reclaims it — visible to `queryQueuePulse()` as locked but absent here.
  const onFatal = ({ worker }: WorkerEventMap["worker:fatalError"]): void => {
    slots.delete(worker.workerId);
    emitQueueActivity();
  };
  const onNotification = ({
    message,
  }: WorkerEventMap["pool:listen:notification"]): void => {
    if (message.channel === INSERT_CHANNEL) emitQueueActivity();
  };

  events.on("job:start", onStart);
  events.on("job:complete", onComplete);
  events.on("worker:fatalError", onFatal);
  if (opts.listenInserts) events.on("pool:listen:notification", onNotification);

  return () => {
    events.off("job:start", onStart);
    events.off("job:complete", onComplete);
    events.off("worker:fatalError", onFatal);
    if (opts.listenInserts) {
      events.off("pool:listen:notification", onNotification);
    }
  };
}

/**
 * Forget every slot and every pickup sample. `stopWorkers` calls it: a graceful
 * shutdown that times out releases its remaining jobs (graphile's `failJobs`)
 * without a `job:complete`, and a stopped pool holds nothing. Activity
 * listeners are left alone — they belong to their subscribers, not to a runner.
 */
export function clearSlotLedger(): void {
  slots.clear();
  for (const ring of pickupSamples.values()) ring.length = 0;
}

function recordPickup(hold: HoldClass, delayMs: number): void {
  const ring = pickupSamples.get(hold)!;
  ring.push({ at: Date.now(), delayMs });
  if (ring.length > PICKUP_SAMPLE_CAP) ring.shift();
}

// graphile reads its rows through a raw `pg` pool, which decodes `timestamptz`
// to `Date` (unlike drizzle's `db.execute`, which leaves strings — see
// resources.ts). Checked rather than assumed: a non-Date here would silently
// become `NaN` in every wait the ledger reports.
function epochMs(job: Job, column: string, value: Date | null): number {
  if (!(value instanceof Date)) {
    throw new Error(
      `[jobs] slot ledger: job ${job.id} (${job.task_identifier}) has ${column} = ${String(value)}, expected a Date`,
    );
  }
  return value.getTime();
}

function jobNameOf(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "jobName" in payload &&
    typeof payload.jobName === "string"
  ) {
    return payload.jobName;
  }
  return "(unknown)";
}

// Report-and-continue, never re-throw — see `emitQueueActivity` for why a throw
// must not reach graphile's emitter.
function guarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const message = `[jobs] slot ledger: ${label} threw: ${errObj.message}`;
    console.error(message, errObj);
    reportServerError({
      message,
      stack: errObj.stack ?? null,
      errorType: errObj.name,
    });
  }
}
