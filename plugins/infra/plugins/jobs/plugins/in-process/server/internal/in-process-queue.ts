import { afterCommit } from "@plugins/database/server";
import {
  announceRunDead,
  answerJobsInMemory,
  JobQueue,
  listRegisteredJobs,
  resolveJobCron,
  pendingWaits,
  singletonJobKey,
  UNSAFE_runJobRow,
  type JobQueueImpl,
  type JobRowOpts,
  type JobRowOutcome,
  type JobTaskPayload,
  type QueuedJob,
  type RegisteredJob,
} from "@plugins/infra/plugins/jobs/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  nextCronFiring,
  parseCrontab,
  type Crontab,
  type JobRow,
  type JobState,
} from "@plugins/infra/plugins/jobs/core";
import { databaseRowStore, type RowStore, type StoredRow } from "./row-store";

/** One queued job: its stored state, plus what only this process knows. */
interface QueueRow extends StoredRow {
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How one dequeued row is run — the jobs plugin's portable row runner. */
type RunRow = (
  payload: JobTaskPayload,
  meta: { jobId: string; attempt: number; maxAttempts: number },
) => Promise<JobRowOutcome>;

/** The in-process queue: the JobQueue host service, plus `settle`. */
export interface InProcessQueue extends JobQueueImpl {
  /** See `settleJobQueue`. */
  settle(): Promise<void>;
}

// Every in-process queue created, so `settleJobQueue` can tell the active
// provider is one without knowing how it was registered.
const inProcessQueues = new WeakSet<JobQueueImpl>();

/**
 * Run the active job queue dry — what a seed calls between its steps, standing
 * for "time has passed": every row queued so far (those a just-committed
 * transaction queues included) and every row they queue in turn runs to
 * completion now, future-dated ones (a debounce, a retry's backoff) fast-
 * forwarded. Resolves on the activity that empties the queue; REJECTS, naming
 * each job and its error, once any row is dead (a pre-existing dead row too).
 *
 * Only the in-process queue settles: on any other provider this throws. Cron
 * schedules are timers, not rows — a tick that is not yet due is left alone.
 */
export function settleJobQueue(): Promise<void> {
  const queue = JobQueue.get();
  if (!inProcessQueues.has(queue)) {
    throw new Error(
      "[jobs/in-process] settleJobQueue: the active JobQueue is not the in-process queue — only a host running it (a browser host) can settle its jobs.",
    );
  }
  return (queue as InProcessQueue).settle();
}

// graphile's own retry backoff: exp(min(attempts, 10)) seconds.
const retryDelayMs = (attempts: number) =>
  Math.exp(Math.min(attempts, 10)) * 1000;

/**
 * The tick of `tab` a schedule missed since `since`, if one is due by `now`
 * and at most `withinMs` old — the latest such, since one run catches up on
 * all of them (graphile's `backfillPeriod` reading of `catchUpWithinMs`).
 */
export function missedTick(
  tab: Crontab,
  since: Date,
  now: Date,
  withinMs: number,
): Date | null {
  const floor = Math.max(since.getTime(), now.getTime() - withinMs);
  // Look back a day, then twice as far each round, down to `floor`: the walk
  // stays near the latest tick however long the window (a per-minute cron
  // over a week's window walks a day's ticks, not a week's).
  for (let span = 86_400_000; ; span *= 2) {
    const from = Math.max(floor, now.getTime() - span);
    let latest: Date | null = null;
    for (
      let t = nextCronFiring(tab, new Date(from));
      t !== null && t.getTime() <= now.getTime();
      t = nextCronFiring(tab, t)
    ) {
      latest = t;
    }
    if (latest !== null || from === floor) return latest;
  }
}

/**
 * The in-process job queue: rows run in this process when they are due, for a
 * host without the desktop's graphile queue (the browser composition, the
 * portable boot test). The rows are kept in memory and written through to
 * `store` — by default the host's own database, so a row outlives the worker
 * that queued it, and a `tx` enqueue writes its row in the caller's
 * transaction (commits or rolls back with the caller's writes). Scheduled jobs
 * fire on a one-shot timer to their next due minute (the portable crontab
 * reading, jobs `core`), and a tick missed while no process ran is caught up
 * per the job's `catchUpWithinMs`, as on the desktop.
 *
 * No slot ladder, no lock, no deadline: rows run as soon as they are due.
 */
export function createInProcessQueue(
  opts: { runRow?: RunRow; store?: RowStore } = {},
): InProcessQueue {
  const runRow = opts.runRow ?? UNSAFE_runJobRow;
  const store = opts.store ?? databaseRowStore();
  const rows = new Map<string, QueueRow>();
  const listeners = new Set<() => void>();
  const scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // What `start()` read back from the store: memoized, so a second start (and
  // `schedule`, which needs the watermarks) reads it once.
  let loading: Promise<ReadonlyMap<string, Date>> | null = null;
  let started = false;
  let scheduled = false;
  // How many `settle()` calls are in progress: while any is, a row is armed to
  // run now whatever its `runAt`.
  let settling = 0;

  // Writes to the store, in order per row (and per schedule), each carrying
  // the row's state when it was asked for; `stop()` waits for those in flight.
  const writeLane = createKeyedMutex();
  const writing = new Set<Promise<void>>();
  const persist = (key: string, write: () => Promise<void>): Promise<void> => {
    const done = writeLane.run(key, write);
    writing.add(done);
    const forget = () => {
      writing.delete(done);
    };
    done.then(forget, forget);
    return done;
  };
  const stored = (row: QueueRow): StoredRow => ({
    id: row.id,
    hold: row.hold,
    payload: row.payload,
    jobKey: row.jobKey,
    runAt: row.runAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    dead: row.dead,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const save = (row: QueueRow) => {
    const snapshot = stored(row);
    return persist(row.id, () => store.update(snapshot));
  };
  const drop = (id: string) => persist(id, () => store.remove(id));
  // Work no caller awaits (a write asked for from a synchronous step, a tick):
  // its own span, and a failure is an unhandled rejection — loud.
  const detach = (label: string, fn: () => Promise<void>): void => {
    void runTracked(`jobs.in-process:${label}`, fn);
  };

  const activity = () => {
    for (const listener of listeners) listener();
  };

  // Runs in progress: `stop()` waits for them, so none writes after the store
  // (the host's database) closes.
  const runs = new Set<Promise<void>>();

  // A timer's longest delay: a longer one fires at once (a 32-bit overflow in
  // every host's setTimeout), so a far-off due time is reached in hops.
  const MAX_TIMER_MS = 2 ** 31 - 1;
  const timerDelay = (at: Date) =>
    Math.min(MAX_TIMER_MS, Math.max(0, at.getTime() - Date.now()));

  function arm(row: QueueRow): void {
    // Only a row still held: one cancelled or finished while a write was in
    // flight must never run.
    if (!started || row.running || row.dead || rows.get(row.id) !== row) return;
    if (settling > 0 && row.runAt.getTime() > Date.now())
      row.runAt = new Date();
    if (row.timer !== null) clearTimeout(row.timer);
    row.timer = setTimeout(() => {
      row.timer = null;
      if (row.runAt.getTime() > Date.now()) {
        arm(row);
        return;
      }
      void runTracked(`jobs.in-process:${row.payload.jobName}`, async () => {
        const running = run(row);
        runs.add(running);
        try {
          await running;
        } finally {
          runs.delete(running);
        }
      });
    }, timerDelay(row.runAt));
  }

  // A row stays `running` until its outcome is written, so neither a collapse
  // nor a cancel acts on it in between.
  async function run(row: QueueRow): Promise<void> {
    row.running = true;
    row.attempts += 1;
    row.updatedAt = new Date();
    activity();
    try {
      // Counted before it runs, as graphile counts an attempt when it locks
      // the row: an attempt the host ends mid-way (the tab closed) is spent,
      // so a run that keeps ending its host cannot loop forever (see `load`).
      await save(row);
      const outcome = await runRow(row.payload, {
        jobId: row.id,
        attempt: row.attempts,
        maxAttempts: row.maxAttempts,
      });
      row.updatedAt = new Date();
      if (outcome.kind !== "failed") {
        rows.delete(row.id);
        await drop(row.id);
        row.running = false;
        activity();
        return;
      }
      row.lastError =
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      if (outcome.retry) {
        row.runAt = new Date(Date.now() + retryDelayMs(row.attempts));
        await save(row);
        row.running = false;
        arm(row);
        activity();
        return;
      }
      // Kept, as graphile keeps a permanently-failed row: Debug → Queue lists
      // it dead until it is retried or removed.
      row.dead = true;
      await save(row);
      row.running = false;
      activity();
    } catch (err) {
      // The store refused a write: the row is dead here (a settle rejects
      // naming it), and the error goes on, loud.
      row.running = false;
      row.dead = true;
      row.lastError = `its queue row could not be written: ${err instanceof Error ? err.message : String(err)}`;
      activity();
      throw err;
    }
    // Dead first, so what the hook sets off reads the run as over.
    await announceRunDead(
      row.payload,
      { cause: "failed", error: row.lastError },
      row.id,
    );
  }

  /**
   * Take a row into the working copy — one just written to the store, or one
   * read back from it. A key collapses onto the pending row already holding it
   * (graphile's replace mode): its payload and due time become the newer
   * row's, its id stays, and the newer row is removed from the store.
   */
  function admit(row: QueueRow): void {
    if (rows.has(row.id)) return;
    if (row.jobKey !== null && !row.dead) {
      for (const held of rows.values()) {
        if (held.jobKey === row.jobKey && !held.running && !held.dead) {
          held.payload = row.payload;
          held.runAt = row.runAt;
          held.updatedAt = new Date();
          detach("collapse", async () => {
            await Promise.all([save(held), drop(row.id)]);
          });
          arm(held);
          activity();
          return;
        }
      }
    }
    rows.set(row.id, row);
    arm(row);
    activity();
  }

  const newRow = (
    job: QueuedJob,
    payload: JobTaskPayload,
    opts: Omit<JobRowOpts, "tx">,
  ): QueueRow => {
    const now = new Date();
    return {
      // Never reused, unlike a counter restarting with the process: a durable
      // run's step and wait logs, in the database, are keyed by the row id.
      id: crypto.randomUUID(),
      hold: job.hold,
      payload,
      jobKey: opts.jobKey ?? null,
      runAt: opts.runAt ?? now,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 1,
      dead: false,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      running: false,
      timer: null,
    };
  };

  function cancelRow(row: QueueRow): Promise<void> {
    if (row.timer !== null) clearTimeout(row.timer);
    rows.delete(row.id);
    return drop(row.id);
  }

  // Read what an earlier process left: every row back in the working copy, a
  // row whose last attempt the host ended mid-way dead (graphile's sweeper
  // reading of a lock whose worker died), and each schedule's watermark.
  async function load(): Promise<ReadonlyMap<string, Date>> {
    const { rows: kept, lastExecutions } = await store.load();
    const ended: QueueRow[] = [];
    for (const r of kept) {
      const row: QueueRow = { ...r, running: false, timer: null };
      if (!row.dead && row.attempts >= row.maxAttempts) {
        row.dead = true;
        row.lastError ??=
          "the host ended while its last attempt ran (the tab closed)";
        row.updatedAt = new Date();
        detach("load", () => save(row));
        ended.push(row);
      }
      admit(row);
    }
    for (const row of ended) {
      await announceRunDead(
        row.payload,
        { cause: "worker-died", error: row.lastError ?? "" },
        row.id,
      );
    }
    return lastExecutions;
  }

  function enqueueTick(
    job: RegisteredJob,
    input: unknown,
    ts: Date,
    backfilled: boolean,
  ): void {
    const row = newRow(
      job,
      {
        jobName: job.name,
        input,
        _cron: { ts: ts.toISOString(), ...(backfilled ? { backfilled } : {}) },
      },
      { jobKey: singletonJobKey(job.name), maxAttempts: job.maxAttempts },
    );
    detach(`tick:${job.name}`, async () => {
      await persist(row.id, () => store.insert(stored(row)));
      admit(row);
    });
    detach(`tick:${job.name}`, () =>
      persist(`schedule:${job.name}`, () => store.recordTick(job.name, ts)),
    );
  }

  function armSchedule(job: RegisteredJob, tab: Crontab, input: unknown): void {
    const due = nextCronFiring(tab, new Date());
    if (due === null) return;
    const fire = (): void => {
      scheduleTimers.delete(job.name);
      if (due.getTime() > Date.now()) {
        // A hop of a far-off due time (`timerDelay`'s bound): wait again.
        scheduleTimers.set(job.name, setTimeout(fire, timerDelay(due)));
        return;
      }
      enqueueTick(job, input, due, false);
      armSchedule(job, tab, input);
    };
    scheduleTimers.set(job.name, setTimeout(fire, timerDelay(due)));
  }

  function installSchedules(
    lastExecutions: ReadonlyMap<string, Date> | null,
  ): void {
    for (const timer of scheduleTimers.values()) clearTimeout(timer);
    scheduleTimers.clear();
    // Stopped before a deferred install ran: nothing arms after `stop()`.
    if (!started) return;
    const now = new Date();
    for (const job of listRegisteredJobs()) {
      const cron = resolveJobCron(job);
      if (cron === null) continue;
      const tab = parseCrontab(cron);
      // A tick takes no caller input: the schema's default shape, as on the
      // desktop — and a schema that cannot default fails loudly here.
      const input = job.inputSchema.parse({});
      if (lastExecutions !== null) {
        const since = lastExecutions.get(job.name);
        const within = job.schedule?.catchUpWithinMs;
        if (since === undefined) {
          // First sight: nothing was missed yet (graphile's rule).
          detach(`tick:${job.name}`, () =>
            persist(`schedule:${job.name}`, () =>
              store.recordTick(job.name, now),
            ),
          );
        } else if (within !== undefined) {
          const missed = missedTick(tab, since, now, within);
          if (missed !== null) enqueueTick(job, input, missed, true);
        }
      }
      armSchedule(job, tab, input);
    }
  }

  const toJobRow = (row: QueueRow): JobRow => {
    const state: JobState = row.running
      ? "running"
      : row.dead
        ? "dead"
        : row.attempts > 0
          ? "retrying"
          : "pending";
    return {
      id: row.id,
      jobName: row.payload.jobName,
      hold: row.hold,
      input: row.payload.input ?? null,
      state,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      runAt: row.runAt,
      lockedAt: row.running ? row.updatedAt : null,
      lockedBy: row.running ? "in-process" : null,
      alive: row.running ? true : null,
      forfeited: false,
      queueName: null,
      priority: 0,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  const answer = () => answerJobsInMemory([...rows.values()].map(toJobRow));

  // Where a settle stands: done (the queue is empty), failed (a row is dead,
  // or nothing will ever run the rows left), or still running.
  function settledVerdict(): "empty" | "pending" | Error {
    const dead = [...rows.values()].filter((row) => row.dead);
    if (dead.length > 0) {
      const which = dead
        .map(
          (row) =>
            `${row.payload.jobName} (row ${row.id}, attempt ${row.attempts}/${row.maxAttempts}): ${row.lastError ?? "no error recorded"}`,
        )
        .join("; ");
      return new Error(
        `[jobs/in-process] settle: ${dead.length} job row(s) ended dead — ${which}`,
      );
    }
    if (rows.size === 0) return "empty";
    if (!started) {
      return new Error(
        `[jobs/in-process] settle: the queue is not started, so its ${rows.size} row(s) would never run.`,
      );
    }
    return "pending";
  }

  async function settle(): Promise<void> {
    // A transaction's enqueue lands at its commit (`afterCommit`): one
    // macrotask lets a caller's just-committed rows in before the first look.
    await yieldMacrotask();
    settling += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          const verdict = settledVerdict();
          if (verdict === "pending") return;
          listeners.delete(check);
          if (verdict === "empty") resolve();
          else reject(verdict);
        };
        listeners.add(check);
        // Every waiting row runs now; a row a run queues or re-arms later
        // (a cascade, a retry) is fast-forwarded by `arm` itself.
        for (const row of rows.values()) {
          if (!row.running && !row.dead) arm(row);
        }
        check();
      });
      // Settled means stored too: a finished row's removal, a collapse's
      // writes have landed (a reload right after reads what settle saw).
      await Promise.all([...writing]);
    } finally {
      settling -= 1;
    }
  }

  const queue: InProcessQueue = {
    settle,
    async enqueue(job, payload, opts) {
      const { tx, ...rest } = opts;
      const row = newRow(job, payload, rest);
      if (tx === undefined) {
        await persist(row.id, () => store.insert(stored(row)));
        admit(row);
      } else {
        // In the caller's transaction: the row is the caller's write, and
        // joins the working copy only once it commits.
        await store.insert(stored(row), tx);
        afterCommit(tx, () => admit(row));
      }
      return { jobId: row.id };
    },
    async cancelUnstarted(match) {
      const removed: Promise<void>[] = [];
      for (const row of [...rows.values()]) {
        if (row.running || row.jobKey === null) continue;
        const hit =
          "key" in match
            ? row.jobKey === match.key
            : row.jobKey.startsWith(match.keyPrefix);
        if (hit) removed.push(cancelRow(row));
      }
      activity();
      await Promise.all(removed);
    },
    // Rows (memory) and pending waits (the database) are not read in one
    // snapshot here, so the rows are read on both sides of the waits read —
    // each a synchronous look. A run between them (a suspend inserts its wait
    // before its row goes; a resume resolves its wait and lands its row at
    // the same commit) holds one or the other at every instant: missed by
    // all three looks only if it resumed AND suspended or finished inside the
    // one waits query. A pending wait counts while its waker row still holds
    // its key (or it has none — an unbounded wait), read right after it.
    async keysInFlight(keys) {
      const holder = (key: string): boolean => {
        for (const row of rows.values()) {
          if (row.jobKey === key && !row.dead) return true;
        }
        return false;
      };
      const held = new Set<string>();
      const lookAtRows = (): void => {
        for (const key of keys) if (holder(key)) held.add(key);
      };
      lookAtRows();
      for (const wait of await pendingWaits(keys)) {
        if (wait.wakerKey === null || holder(wait.wakerKey))
          held.add(wait.workflowRunId);
      }
      lookAtRows();
      return held;
    },
    // The `jobs` collection's questions, answered over every row held — the
    // queue is this host's own handful of jobs.
    async window(q) {
      return answer().window(q);
    },
    async rows(ids) {
      return answer().rows(ids);
    },
    async groups(q) {
      return answer().groups(q);
    },
    async count(q) {
      return answer().count(q);
    },
    async retry(jobId) {
      const row = rows.get(jobId);
      if (row === undefined || row.running) return;
      row.attempts = 0;
      row.dead = false;
      row.runAt = new Date();
      row.updatedAt = new Date();
      await save(row);
      arm(row);
      activity();
    },
    async cancel(jobId) {
      const row = rows.get(jobId);
      if (row === undefined || row.running) return;
      await cancelRow(row);
      activity();
      await announceRunDead(
        row.payload,
        {
          cause: "cancelled",
          error: "its queue row was removed (Debug → Queue)",
        },
        row.id,
      );
    },
    onActivity(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async install() {},
    async start() {
      started = true;
      await (loading ??= load());
      for (const row of rows.values()) arm(row);
    },
    schedule() {
      if (loading === null) {
        throw new Error(
          "[jobs/in-process] schedule() before start(): the missed ticks are read from what start() loaded.",
        );
      }
      // Missed ticks are caught up once, by the first install.
      const catchUp = !scheduled;
      scheduled = true;
      const loaded = loading;
      detach("schedule", async () => {
        const lastExecutions = await loaded;
        installSchedules(catchUp ? lastExecutions : null);
      });
    },
    refreshSchedules() {
      // A refresh re-reads the crontabs only: missed ticks are caught up once,
      // when the schedules are first installed.
      if (scheduled) installSchedules(null);
    },
    async stop() {
      started = false;
      for (const row of rows.values()) {
        if (row.timer !== null) clearTimeout(row.timer);
        row.timer = null;
      }
      for (const timer of scheduleTimers.values()) clearTimeout(timer);
      scheduleTimers.clear();
      // A settle in progress fails now rather than wait on rows nothing runs.
      activity();
      scheduled = false;
      // The store (the host's database) closes after this: the runs in
      // progress finish and their writes land first.
      await Promise.allSettled([...runs]);
      await Promise.allSettled([...writing]);
    },
  };
  inProcessQueues.add(queue);
  return queue;
}
