import type { WorkerEventMap, WorkerEvents, WorkerPool } from "graphile-worker";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { runInBackgroundLane } from "@plugins/infra/plugins/runtime-profiler/core";
import { CRON_RESOLUTION_MS } from "../../core/cron";
import type { QueueDueByTask } from "./introspection";
import { onQueueActivity } from "./slot-ledger";

// The queue wake: what tells graphile's idle workers a row is there to fetch,
// in place of graphile's poll.
//
// graphile 0.18 in continuous mode re-runs its `get_job` fetch every
// `pollInterval` (default 2 s) for EVERY idle worker slot — on top of its LISTEN
// on `jobs:insert`. With 8 slots per backend that was ~4 fetch queries a second
// on every backend, forever, and it kept the runner pool's connections busy so
// none of them ever idled out (~11 `jobs-runner` connections held per backend,
// 101 across the cluster on 2026-11-08).
//
// The poll covers exactly the rows NO notification announces: graphile's
// `add_job` / `add_jobs` notify on every insert (future-dated or not), and
// nothing else does. So what the poll found were rows that became fetchable
// without an insert:
//
// - a future `run_at` coming due — `enqueue({ runAt })`, `ctx.sleep` / a wait's
//   timeout racer, and the retry backoff a failed attempt's unlock writes;
// - a row freed by a write that sends no notification: a serial lane released
//   by its holder's outcome, the stuck-lock sweeper's reclaim, a Debug → Queue
//   retry (every such write carries `QueueActivity.ready`, slot-ledger.ts);
// - a fetch that failed (graphile retries it after `pollInterval`);
// - graphile's own `resetLocked` unlocking rows locked over 4 hours;
// - inserts committed while a runner's LISTEN connection was down.
//
// Each now has its own signal, and the poll is switched off
// (`NO_POLL_INTERVAL_MS`):
//
// - `ready` activity, a LISTEN (re)connect and `resetLocked` run one `queryQueueDue` and nudge
//   each runner for the rows its task list can fetch now;
// - every wake also arms ONE timer to the earliest future `run_at` of the
//   queue, re-armed whenever the earliest may have moved (an insert, a failure
//   outcome, a timer firing). It is a deadline at a known instant, not a loop:
//   with nothing future-dated in the queue, no timer runs at all;
// - a failed fetch wakes the queue after `FETCH_ERROR_RETRY_MS`, graphile's own
//   retry delay, so a database blip costs what it did before.
//
// An insert is NOT nudged here: graphile's LISTEN client already wakes its
// workers for one, and a second nudge would double every fetch. It only
// re-arms the timer, since the new row may be future-dated.

/**
 * graphile's `pollInterval`, set so the poll never fires: graphile has no
 * "off", and Node/Bun timers overflow past 2^31 − 1 ms (a larger value fires at
 * once). The longest representable delay (~24.8 days) — every worker is woken
 * long before by the queue wake. Not a slower poll: nothing relies on it.
 */
export const NO_POLL_INTERVAL_MS = 2 ** 31 - 1;

// graphile's own delay before re-fetching after a failed `get_job` (its default
// `pollInterval`), kept for that one path: a fetch error is a lost or slow
// connection, and the wake re-fetches the way graphile did.
const FETCH_ERROR_RETRY_MS = 2_000;

// The timer's longest single sleep. A timer's delay is measured on a clock that
// stops while the machine sleeps, so a 10-minute timer armed before an 8-hour
// sleep would fire 9 minutes after waking. Capped at the cron resolution, the
// timer re-reads the WALL clock at least once a minute and fires as soon as
// its instant has passed — the same bound graphile's cron has after a wake.
// A capped sleep that ends early only re-arms; it reads nothing.
const CLOCK_RECHECK_MS = CRON_RESOLUTION_MS;

interface WakeTarget {
  readonly runnerId: string;
  /** The graphile task identifiers this runner's task list serves. */
  readonly tasks: readonly string[];
  /** Set by graphile's `pool:create` (inside `run()`), cleared on release. */
  pool: WorkerPool | null;
}

export interface QueueWake {
  /**
   * Wake one runner's workers on the signals above. Attach BEFORE `run()`:
   * graphile emits `pool:create` and connects its LISTEN client inside it.
   * `listenInserts` on exactly one runner — each runner has its own LISTEN
   * client, and one re-arm per insert is enough. Returns a detach function;
   * the last detach stops the wake.
   */
  attach(
    runnerId: string,
    tasks: readonly string[],
    events: WorkerEvents,
    opts: { listenInserts: boolean },
  ): () => void;
}

/** One backend's queue wake over its runners. `readDue` is `queryQueueDue`
 * on the queue's database. */
export function createQueueWake(opts: {
  readDue: () => Promise<Map<string, QueueDueByTask>>;
}): QueueWake {
  const targets = new Set<WakeTarget>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock instant (epoch ms) the armed timer stands for. */
  let armedFor: number | null = null;
  /** A wake owed to a failed read (a fetch, or the wake's own query). Its own
   * one-shot, so no re-arm of the due timer can drop it. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  /** Inside a streak of failed reads: only its first is reported. */
  let failing = false;
  let detachActivity: (() => void) | null = null;

  // One wake at a time; every trigger landing mid-wake folds into one trailing
  // wake, nudging if any folded trigger asked to.
  const wakes = createCoalescer<boolean>({
    run: (nudges) => wakeOnce(nudges.includes(true)),
  });

  function wake(nudge: boolean): void {
    if (!stopped) wakes.trigger([nudge]);
  }

  async function wakeOnce(nudge: boolean): Promise<void> {
    if (stopped) return;
    let due: Map<string, QueueDueByTask>;
    try {
      due = await runInBackgroundLane(() => opts.readDue());
    } catch (err) {
      // Not swallowed: reported, and the wake runs again, as a failed fetch
      // does. Once per streak — a database down for minutes is one report.
      if (!failing) {
        report(
          `reading the due rows failed (retrying every ${FETCH_ERROR_RETRY_MS} ms until a read succeeds)`,
          err,
        );
      }
      failing = true;
      retryAfterError();
      return;
    }
    failing = false;
    if (stopped) return;
    if (nudge) {
      for (const target of targets) {
        let n = 0;
        for (const task of target.tasks) n += due.get(task)?.due ?? 0;
        nudgePool(target, n);
      }
    }
    let next: number | null = null;
    for (const { nextInMs } of due.values()) {
      if (nextInMs !== null && (next === null || nextInMs < next))
        next = nextInMs;
    }
    // The read is the whole truth about future rows: it replaces what was armed.
    clearTimer();
    if (next !== null) {
      armedFor = Date.now() + Math.max(0, next);
      scheduleCheck();
    }
  }

  function nudgePool(target: WakeTarget, n: number): void {
    const pool = target.pool;
    // graphile asserts on a nudge after its workers are released.
    if (n <= 0 || !pool || !pool._active || pool._shuttingDown) return;
    try {
      pool.nudge(n);
    } catch (err) {
      report(`nudging runner ${target.runnerId} threw`, err);
    }
  }

  function retryAfterError(): void {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      wake(true);
    }, FETCH_ERROR_RETRY_MS);
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    armedFor = null;
  }

  function scheduleCheck(): void {
    if (armedFor === null) return;
    const remaining = Math.max(0, armedFor - Date.now());
    timer = setTimeout(onTimer, Math.min(remaining, CLOCK_RECHECK_MS));
  }

  function onTimer(): void {
    timer = null;
    if (armedFor === null || stopped) return;
    if (Date.now() < armedFor) {
      scheduleCheck();
      return;
    }
    armedFor = null;
    wake(true);
  }

  function stop(): void {
    stopped = true;
    clearTimer();
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    detachActivity?.();
    detachActivity = null;
  }

  return {
    attach(runnerId, tasks, events, attachOpts) {
      stopped = false;
      detachActivity ??= onQueueActivity((activity) => {
        if (activity.ready) wake(true);
      });
      const target: WakeTarget = { runnerId, tasks, pool: null };
      targets.add(target);

      const onCreate = ({
        workerPool,
      }: WorkerEventMap["pool:create"]): void => {
        target.pool = workerPool;
      };
      const onRelease = (): void => {
        target.pool = null;
      };
      // First connect at boot, and every reconnect: rows inserted while the
      // LISTEN connection was down were announced to nobody.
      const onListen = (): void => wake(true);
      // graphile's `resetLocked` (rows locked > 4 h, every ~10 min) unlocks
      // rows and lanes and sends no notification.
      const onResetLocked = (): void => wake(true);
      const onFetchError = (): void => retryAfterError();
      const onNotification = ({
        message,
      }: WorkerEventMap["pool:listen:notification"]): void => {
        if (message.channel === "jobs:insert") wake(false);
      };

      events.on("pool:create", onCreate);
      events.on("pool:gracefulShutdown", onRelease);
      events.on("pool:release", onRelease);
      events.on("pool:listen:success", onListen);
      events.on("resetLocked:success", onResetLocked);
      events.on("worker:getJob:error", onFetchError);
      if (attachOpts.listenInserts) {
        events.on("pool:listen:notification", onNotification);
      }

      return () => {
        events.off("pool:create", onCreate);
        events.off("pool:gracefulShutdown", onRelease);
        events.off("pool:release", onRelease);
        events.off("pool:listen:success", onListen);
        events.off("resetLocked:success", onResetLocked);
        events.off("worker:getJob:error", onFetchError);
        if (attachOpts.listenInserts) {
          events.off("pool:listen:notification", onNotification);
        }
        targets.delete(target);
        if (targets.size === 0) stop();
      };
    },
  };
}

function report(what: string, err: unknown): void {
  const errObj = err instanceof Error ? err : new Error(String(err));
  reportServerError({
    message: `[jobs] queue wake: ${what}: ${errObj.message}`,
    stack: errObj.stack ?? null,
    errorType: errObj.name,
  });
}
