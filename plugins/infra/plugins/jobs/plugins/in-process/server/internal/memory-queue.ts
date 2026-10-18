import { afterCommit } from "@plugins/database/server";
import {
  listRegisteredJobs,
  resolveJobCron,
  singletonJobKey,
  UNSAFE_runJobRow,
  type JobQueueImpl,
  type JobRowOpts,
  type JobTaskPayload,
  type QueuedJob,
} from "@plugins/infra/plugins/jobs/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  nextCronFiring,
  parseCrontab,
  type JobRow,
  type JobState,
} from "@plugins/infra/plugins/jobs/core";

/** One queued job, held in memory. */
interface MemoryRow {
  id: string;
  job: QueuedJob;
  payload: JobTaskPayload;
  jobKey: string | null;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  running: boolean;
  dead: boolean;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  timer: ReturnType<typeof setTimeout> | null;
}

// graphile's own retry backoff: exp(min(attempts, 10)) seconds.
const retryDelayMs = (attempts: number) =>
  Math.exp(Math.min(attempts, 10)) * 1000;

/**
 * An in-memory job queue: rows run in this process when they are due, nothing
 * survives a reload. For a host without the desktop's graphile queue (the
 * browser composition, the portable boot test). Every enqueue is a row; a
 * `tx` enqueue inserts its row only once that transaction commits
 * (`afterCommit`), so a rollback drops the job with the caller's writes, as on
 * the desktop. Scheduled jobs fire on a one-shot timer to their next due
 * minute (the portable crontab reading, jobs `core`), re-armed after each.
 *
 * No slot ladder, no lock, no deadline: rows run as soon as they are due.
 */
export function createMemoryQueue(): JobQueueImpl {
  const rows = new Map<string, MemoryRow>();
  const listeners = new Set<() => void>();
  const scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let started = false;
  let scheduled = false;
  let seq = 0;

  const activity = () => {
    for (const listener of listeners) listener();
  };

  function arm(row: MemoryRow): void {
    if (!started || row.running || row.dead) return;
    if (row.timer !== null) clearTimeout(row.timer);
    row.timer = setTimeout(
      () => {
        row.timer = null;
        void runTracked(`jobs.in-process:${row.payload.jobName}`, () =>
          run(row),
        );
      },
      Math.max(0, row.runAt.getTime() - Date.now()),
    );
  }

  async function run(row: MemoryRow): Promise<void> {
    row.running = true;
    row.attempts += 1;
    row.updatedAt = new Date();
    activity();
    const outcome = await UNSAFE_runJobRow(row.payload, {
      jobId: row.id,
      attempt: row.attempts,
      maxAttempts: row.maxAttempts,
    });
    row.running = false;
    row.updatedAt = new Date();
    if (outcome.kind === "failed") {
      row.lastError =
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      if (outcome.retry) {
        row.runAt = new Date(Date.now() + retryDelayMs(row.attempts));
        arm(row);
      } else {
        // Kept, as graphile keeps a permanently-failed row: Debug → Queue
        // lists it dead until it is retried or removed.
        row.dead = true;
      }
    } else {
      rows.delete(row.id);
    }
    activity();
  }

  function insert(
    job: QueuedJob,
    payload: JobTaskPayload,
    opts: Omit<JobRowOpts, "tx">,
    id: string,
  ): void {
    const key = opts.jobKey ?? null;
    // A key collapses onto the pending row holding it (graphile's replace
    // mode): its payload and due time are the newer enqueue's, its id stays.
    if (key !== null) {
      for (const row of rows.values()) {
        if (row.jobKey === key && !row.running && !row.dead) {
          row.payload = payload;
          row.runAt = opts.runAt ?? new Date();
          row.updatedAt = new Date();
          arm(row);
          activity();
          return;
        }
      }
    }
    const now = new Date();
    const row: MemoryRow = {
      id,
      job,
      payload,
      jobKey: key,
      runAt: opts.runAt ?? now,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 1,
      running: false,
      dead: false,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      timer: null,
    };
    rows.set(id, row);
    arm(row);
    activity();
  }

  function cancelRow(row: MemoryRow): void {
    if (row.timer !== null) clearTimeout(row.timer);
    rows.delete(row.id);
  }

  function armSchedule(name: string, cron: string, input: unknown): void {
    const tab = parseCrontab(cron);
    const due = nextCronFiring(tab, new Date());
    if (due === null) return;
    const job = listRegisteredJobs().find((j) => j.name === name);
    if (job === undefined) return;
    scheduleTimers.set(
      name,
      setTimeout(() => {
        scheduleTimers.delete(name);
        insert(
          job,
          { jobName: name, input },
          { jobKey: singletonJobKey(name), maxAttempts: job.maxAttempts },
          String(++seq),
        );
        armSchedule(name, cron, input);
      }, due.getTime() - Date.now()),
    );
  }

  function installSchedules(): void {
    for (const timer of scheduleTimers.values()) clearTimeout(timer);
    scheduleTimers.clear();
    for (const job of listRegisteredJobs()) {
      const cron = resolveJobCron(job);
      if (cron === null) continue;
      // A tick takes no caller input: the schema's default shape, as on the
      // desktop — and a schema that cannot default fails loudly here.
      armSchedule(job.name, cron, job.inputSchema.parse({}));
    }
  }

  const toJobRow = (row: MemoryRow): JobRow => {
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
      hold: row.job.hold,
      input: row.payload.input ?? null,
      state,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      runAt: row.runAt.toISOString(),
      lockedAt: row.running ? row.updatedAt.toISOString() : null,
      lockedBy: row.running ? "in-process" : null,
      alive: row.running ? true : null,
      forfeited: false,
      queueName: null,
      priority: 0,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  };

  return {
    async enqueue(job, payload, opts) {
      const id = String(++seq);
      const { tx, ...rest } = opts;
      if (tx === undefined) insert(job, payload, rest, id);
      else afterCommit(tx, () => insert(job, payload, rest, id));
      return { jobId: id };
    },
    async cancelUnstarted(match) {
      for (const row of [...rows.values()]) {
        if (row.running || row.jobKey === null) continue;
        const hit =
          "key" in match
            ? row.jobKey === match.key
            : row.jobKey.startsWith(match.keyPrefix);
        if (hit) cancelRow(row);
      }
      activity();
    },
    async list(limit) {
      const all = [...rows.values()]
        .sort((a, b) => b.runAt.getTime() - a.runAt.getTime())
        .slice(0, limit)
        .map(toJobRow);
      const counts = { pending: 0, running: 0, retrying: 0, dead: 0 };
      for (const r of all) counts[r.state]++;
      return { rows: all, counts };
    },
    async retry(jobId) {
      const row = rows.get(jobId);
      if (row === undefined || row.running) return;
      row.attempts = 0;
      row.dead = false;
      row.runAt = new Date();
      arm(row);
      activity();
    },
    async cancel(jobId) {
      const row = rows.get(jobId);
      if (row === undefined || row.running) return;
      cancelRow(row);
      activity();
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
      for (const row of rows.values()) arm(row);
    },
    schedule() {
      scheduled = true;
      installSchedules();
    },
    refreshSchedules() {
      if (scheduled) installSchedules();
    },
    async stop() {
      started = false;
      for (const row of rows.values()) {
        if (row.timer !== null) clearTimeout(row.timer);
        row.timer = null;
      }
      for (const timer of scheduleTimers.values()) clearTimeout(timer);
      scheduleTimers.clear();
    },
  };
}
