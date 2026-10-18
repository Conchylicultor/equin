import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { sql } from "drizzle-orm";
import { EventEmitter } from "node:events";
import {
  makeWorkerUtils,
  parseCronItem,
  run,
  type JobHelpers,
  type ParsedCronItem,
  type Runner,
  type TaskList,
  type WorkerEvents,
  type WorkerUtils,
} from "graphile-worker";
import type { Pool } from "pg";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { connectionString } from "@plugins/database/plugins/admin/server";
import { createDbPool } from "@plugins/database/plugins/connection/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import {
  recordEntrySpan,
  runInBackgroundLane,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  ALL_JOB_TASKS,
  HOLD_CLASSES,
  LEGACY_JOB_TASK,
  priorityFor,
  RUNNERS,
  taskFor,
  TOTAL_JOB_SLOTS,
  type HoldClass,
} from "../../core/hold";
import {
  getScheduledJobs,
  jobRegistry,
  resolveJobCron,
  UNSAFE_getRegisteredJob,
  type JobTaskPayload,
} from "../../server/internal/registry";
import { scheduleResume } from "../../server/internal/resume-job";
import { queueNameFor } from "./graphile-routing";
import { armDeadline } from "./deadline";
import {
  singletonJobKey,
  workflowRunIdFor,
} from "../../server/internal/run-identity";
import {
  isSuspendSignal,
  makeDurableCtx,
} from "../../server/internal/step-ctx";
import { LOCK_HELD, withJobLock } from "./job-lock";
import { markJobPermanentlyFailed } from "./introspection";
import {
  classifyFailure,
  discardWorkflowLog,
} from "../../server/internal/workflow-log";
import { attachSlotLedger, clearSlotLedger } from "./slot-ledger";
import { attachRunStats, clearRunStats, markRunSuspended } from "./run-stats";
import { jobsLog } from "./jobs-log";
import { nextFiring } from "./cron-schedule";

// One runner per entry in the ladder (`RUNNERS`), all sharing one pg pool.
let runners: Runner[] | null = null;

// One slot-ledger detach per runner, undone by `stopWorkers`.
let ledgerDetaches: (() => void)[] = [];

// The ONE connection pool behind every runner. graphile only `.end()`s a pool it
// created itself (`dist/lib.js:180-200` — the `releasers.push(() => pgPool.end())`
// lines sit in the `connectionString` / `PGDATABASE` branches, never in the
// `_rawOptions.pgPool` branch), so a caller-supplied pool survives `runner.stop()`
// and three runners can safely share it. `stopWorkers()` ends it explicitly.
//
// Sized `TOTAL_JOB_SLOTS + RUNNERS.length`: one connection per worker slot plus
// one per runner for its own LISTEN/poll client. Three runners left to build
// their own default pools would be 30 connections per backend, against a cluster
// with ~16 live backends — the reason the shared pool is not an optimization.
//
// NOTE `pgPool` and `connectionString` are mutually exclusive in graphile's own
// assertion (`dist/lib.js:182-186`), so the runner options below pass neither
// `connectionString` nor `maxPoolSize`.
//
// Built by `createDbPool` (`jobs-runner`): every connect and every statement a
// runner issues — job fetch, completion, its LISTEN client's connect — carries
// the connection plugin's deadline, and a call that gets no reply rejects with
// `QueryDeadlineExceededError` naming this pool instead of pinning a slot.
let runnerPool: Pool | null = null;

function getRunnerPool(): Pool {
  if (!runnerPool) {
    runnerPool = createDbPool({
      name: "jobs-runner",
      connectionString: connectionString(),
      max: TOTAL_JOB_SLOTS + RUNNERS.length,
    });
  }
  return runnerPool;
}

// The pool behind `WorkerUtils` (`addJob` and friends). Built here and handed to
// graphile as `pgPool` rather than letting graphile build one from a
// `connectionString`, so every enqueue carries the deadline (`jobs-enqueue`).
// graphile's own default was `maxPoolSize` 10; kept. Handing it over has the
// same ownership consequence as the runner pool: `utils.release()` does NOT end
// a caller-supplied pool, so `stopWorkers()` ends it after the release.
const ENQUEUE_POOL_MAX = 10;
let enqueuePool: Pool | null = null;

function getEnqueuePool(): Pool {
  if (!enqueuePool) {
    enqueuePool = createDbPool({
      name: "jobs-enqueue",
      connectionString: connectionString(),
      max: ENQUEUE_POOL_MAX,
    });
  }
  return enqueuePool;
}

// Lazy singleton. The first `enqueue()` call (which may land before
// `startWorkers()` in the onReady cycle) initializes this; `makeWorkerUtils`
// runs Graphile's own migrations, which are idempotent and safe to race with
// the runner's init.
//
// A rejected build is not cached: its error reaches every caller that awaited
// it, and the next call builds again. Now that its migration check can fail on a
// missed deadline (a transient, lost connection), caching the rejection would
// turn one lost connection into an enqueue path broken until restart.
let workerUtilsPromise: Promise<WorkerUtils> | null = null;

export function getWorkerUtils(): Promise<WorkerUtils> {
  if (!workerUtilsPromise) {
    const building: Promise<WorkerUtils> = makeWorkerUtils({
      pgPool: getEnqueuePool(),
    }).then(
      (utils) => utils,
      (err: unknown) => {
        if (workerUtilsPromise === building) workerUtilsPromise = null;
        throw err;
      },
    );
    workerUtilsPromise = building;
  }
  return workerUtilsPromise;
}

// Live, mutable cron-item array handed to graphile-worker's run(). Graphile
// re-reads this reference on every tick (its docs declare it mutable), so we
// hand it over empty at worker start and populate it later in
// `installScheduledCronItems()` — once every plugin is ready, since a schedule
// resolver may read another plugin's config (populated in its onReady).
const scheduledCronItems: ParsedCronItem[] = [];

// Whether the onAllReady install has run: before it, a schedule resolver may
// read config that is not loaded yet, so a refresh must not install early.
let cronItemsInstalled = false;
const scheduleListeners = new Set<() => void>();

// (Re)build cron items from the registry into the live array. Call once after
// the onAllReady barrier; `refreshJobSchedules` calls it again.
export function installScheduledCronItems(): void {
  scheduledCronItems.splice(0, scheduledCronItems.length, ...buildCronItems());
  cronItemsInstalled = true;
  for (const listener of scheduleListeners) listener();
}

/**
 * Re-read every resolver-form schedule now and install the result, so a
 * schedule a setting decides changes without a restart. graphile re-reads the
 * live cron-item array each tick, so the next tick already uses it. Before the
 * onAllReady install it does nothing: that install reads the same resolvers.
 */
export function refreshJobSchedules(): void {
  if (!cronItemsInstalled) return;
  installScheduledCronItems();
}

/**
 * Be told when the installed schedules were (re)built — a display of a job's
 * next firing reads again. Returns the unsubscribe. Listeners must be cheap
 * (a live value's `notify()`).
 */
export function onJobSchedulesChanged(listener: () => void): () => void {
  scheduleListeners.add(listener);
  return () => {
    scheduleListeners.delete(listener);
  };
}

// The one spelling of a job's cron identifier (graphile's known_crontabs key).
function cronIdentifier(jobName: string): string {
  return `cron:${jobName}`;
}

/**
 * When a scheduled job next fires in THIS backend, by the installed cron item's
 * own matcher: `{ installed: false }` when this backend did not install it (a
 * main-only schedule in a worktree, a resolver that returned null, or before
 * the `onAllReady` install), else the next firing (`null` past the lookahead).
 */
export function nextScheduledRun(
  jobName: string,
  from: Date,
): { installed: false } | { installed: true; next: Date | null } {
  const identifier = cronIdentifier(jobName);
  const item = scheduledCronItems.find((i) => i.identifier === identifier);
  if (item === undefined) return { installed: false };
  return { installed: true, next: nextFiring(item, from) };
}

// Build graphile-worker cron items from every job that declared a `schedule`.
// Resolver-form schedules are evaluated here so a job can derive its crontab
// from config or disable itself by returning null. A tick lands on the job's own
// hold-class task at that class's priority — the same derivation every enqueue
// path uses, so a scheduled job is reachable by exactly the runners its class
// says it is. The per-tick payload carries the job name and its default input,
// and graphile injects `_cron`. Exported for `run-identity.test.ts`.
export function buildCronItems(): ParsedCronItem[] {
  const items: ParsedCronItem[] = [];
  const main = isMain();
  for (const job of getScheduledJobs()) {
    const { schedule } = job;
    if (!schedule) continue;
    // graphile's known_crontabs dedup is per-database, and every worktree
    // backend runs its own worker against its own DB — so a schedule left to
    // run everywhere fires once per live worktree. Default to main-only;
    // perWorktree jobs opt back in to running in every worktree.
    if (!main && !schedule.perWorktree) continue;
    const cron = resolveJobCron(job);
    if (cron === null) continue;
    // Scheduled jobs take no caller input; the tick payload is the schema's
    // default shape. Fail loud at startup if the input isn't defaultable.
    const input = job.inputSchema.parse({});
    items.push(
      parseCronItem({
        task: taskFor(job.hold),
        match: cron,
        identifier: cronIdentifier(job.name),
        payload: { jobName: job.name, input } satisfies JobTaskPayload,
        options: {
          // backfillPeriod 0 ⇒ no catch-up flood on boot.
          backfillPeriod: 0,
          maxAttempts: job.maxAttempts,
          // The class's fetch priority, alongside its task above. graphile's
          // cron path passes this straight into the tick's job spec, and the
          // `jobKey` upsert below re-stamps both columns from `excluded`
          // (`sql/000018.sql`, `add_jobs`: `task_id = excluded.task_id,
          // priority = excluded.priority`) — so a pending tick row inserted by
          // an older backend is re-pointed by the very next tick, without
          // waiting for a boot.
          priority: priorityFor(job.hold),
          // Without a jobKey the cron path ignored `dedup` entirely — every
          // tick INSERTed a brand-new row, forever. On 2026-08-17 main's queue
          // wedged for 70 min and had accumulated 57 copies each of six
          // per-minute monitors, including the queue-health monitor whose whole
          // purpose is to report that condition.
          //
          // `singletonJobKey` is the same derivation `enqueue()` uses for a
          // `dedup: "singleton"` job (`run-identity.ts`). Sharing it is the
          // point: a manual `enqueue()` and a cron tick then collapse onto the
          // SAME pending row instead of racing as two. That key is only TOTAL
          // because `DefineJobSpec` types a scheduled job as `dedup: "singleton"` —
          // if a schedule could be keyed, this line would be a lie for it.
          //
          // "preserve_run_at" is MANDATORY, not a preference. graphile's
          // `add_jobs` (sql/000018.sql:161-164) keeps the original `run_at` on
          // conflict only in this mode, and only while `attempts = 0`:
          //   run_at = (case
          //     when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
          //     else excluded.run_at
          //   end)
          // Under the default "replace" a pending row's `run_at` is pushed
          // forward on EVERY tick, which (i) starves a `* * * * *` job in a
          // merely-busy queue — it is perpetually re-scheduled a minute out and
          // never becomes the oldest ready row — and (ii) resets
          // `oldestOverdueMs` to near-zero every minute during a wedge, making
          // the backlog signal QUIETER than it is with no dedup at all. The
          // dedup fix and the queue-health backlog signal only compose in this
          // mode.
          //
          // A key CANNOT silence a schedule, which is the first thing to check
          // when adding one. The collapse-onto-one-row upsert above is gated
          // `where jobs.locked_at is null`; separately (000018.sql:107-116)
          // graphile first clears `key` on any row that is not `is_available`,
          // and `is_available` is `locked_at is null AND attempts < max_attempts`
          // (000011.sql:67). So a row that is mid-run — or that has already
          // dead-lettered — releases the key and this tick inserts a fresh row.
          // An OVERRUNNING run has its retry budget collapsed to `attempts =
          // max_attempts` when the next tick fires, and because it was locked
          // at that moment our trigger marks it SUPERSEDED (`supersededExpr`,
          // jobs/CLAUDE.md "Superseded rows"). A successful overrun is still
          // just deleted, so nothing is lost. A FAILING one is reported by
          // `dispatch()` like any failure, and is then dropped by the
          // stuck-lock sweeper instead of dead-lettering — the fresh tick row
          // is its retry, so it never reaches `queue-dead-job` or the dead
          // archive.
          jobKey: singletonJobKey(job.name),
          jobKeyMode: "preserve_run_at",
          // A scheduled job that declared `serial` must tick INTO its own queue,
          // or every cron tick would be the one insertion that escapes the
          // serialization. `CronItemOptions.queueName` is graphile's supported
          // spelling for exactly this (`dist/interfaces.d.ts:172` —
          // "set the job queue_name to enforce that the jobs run serially"), and
          // `dist/cron.js:65` passes it straight into the tick's job spec.
          // Derived through the same `queueNameFor` as the four enqueue paths, so
          // there is one rule about what a job's queue is called and not two.
          queueName: queueNameFor(job),
        },
        // NOTE the payload deliberately carries NO `workflowRunId`. `jobKey` is
        // QUEUE-ROW dedup (at most one pending row per job); `workflowRunId` is
        // RUN identity, the memoization key for `_jobSteps` / `_jobWaits`.
        // `dispatch()` derives it from the row id (`workflowRunIdFor`), so each
        // row a tick inserts is its own run, and a tick collapsing onto a
        // pending row joins that row's run. Collapsing run and key would make
        // every tick of a scheduled workflow replay the FIRST tick's cached
        // steps forever.
      }),
    );
  }
  return items;
}

// The one handler body behind every task identifier, closed over the id of the
// runner that will call it. Which graphile task a row sits on decides WHICH
// SLOTS can fetch it — never which code runs it, which is always this.
//
// The closure is what makes `runnerId` knowable at all. graphile hands a task
// function no identity of the runner invoking it, and nothing on the job row
// records one either (the three runners share one job table), so a single shared
// function physically cannot say which of the ladder's slots it is occupying.
// Slot forfeit accounting is per-runner — "the `wide` runner can no longer do
// its job" is a statement about one runner's slots — so this is load-bearing
// rather than cosmetic.
//
// `helpers` is graphile's real `JobHelpers` and must stay that way — do NOT
// loosen it back to `any` for the two fields we read. It WAS `any`, and that is
// exactly how a read of `helpers.workerId` (a field `JobHelpers` does not have)
// survived three months as the literal string `"undefined"` instead of being a
// tsc error, silently disabling the keepalive that was supposed to stop jobs
// double-running.
function makeJobTaskHandler(
  runnerId: string,
): (payload: unknown, helpers: JobHelpers) => Promise<void> {
  return async function handleJobTask(
    payload: unknown,
    helpers: JobHelpers,
  ): Promise<void> {
    const p = payload as JobTaskPayload;
    await dispatch(p, {
      jobId: String(helpers.job.id),
      attempt: Number(helpers.job.attempts),
      // The ROW's budget, not the registered job's: `enqueue(input, {
      // maxAttempts })` overrides it per row, so only the fetched job knows how
      // many attempts this one gets. `dispatch()` compares it against `attempt`
      // to recognise the last attempt.
      maxAttempts: Number(helpers.job.max_attempts),
      runnerId,
    });
  };
}

/**
 * Start one graphile runner per entry in the {@link RUNNERS} ladder, all sharing
 * one pool, all dispatching into the same handler.
 *
 * The reservation lives in the `taskList` and nowhere else: graphile's fetch
 * query filters `task_id = any($2::int[])` (`dist/sql/getJob.js`), so a runner
 * physically cannot see a task identifier absent from its own list. The floor
 * runner serves only `instant`, so nothing that can run for minutes can ever
 * hold its two slots — a guarantee an in-process gate entered after dispatch
 * could not give (it would turn one stuck job into N stuck slots, the lesson
 * `serial` exists to encode).
 */
export async function startWorkers(): Promise<Runner[]> {
  if (runners) return runners;

  // Graphile's schema must exist before `repointHoldTasks` can UPDATE its tables.
  // `makeWorkerUtils` runs graphile's own (idempotent) migrations
  // (`dist/lib.js` `getUtilsAndReleasersFromOptions`), so awaiting it here is
  // what makes the re-point safe on a first-ever boot.
  await getWorkerUtils();
  await repointHoldTasks();

  const pgPool = getRunnerPool();
  const started: Runner[] = [];
  for (const spec of RUNNERS) {
    // One handler instance per runner, so every dispatch knows which runner's
    // slot it is holding. Built once per runner, not once per task — every entry
    // in this runner's list is served by the same slots.
    const handleJobTask = makeJobTaskHandler(spec.id);
    const taskList: TaskList = {};
    for (const hold of spec.serves) taskList[taskFor(hold)] = handleJobTask;
    // The legacy `jobs.run` task stays registered in exactly one runner,
    // FOREVER. It costs one taskList entry and makes a stranded row impossible
    // by construction: a row not re-pointed — written mid-deploy, or by an older
    // backend — still runs, in the most conservative tier.
    if (spec.legacy) taskList[LEGACY_JOB_TASK] = handleJobTask;

    // This runner's own emitter, so every event on it is known to come from
    // THIS runner's slots — the one piece of identity graphile never records.
    // Attached before `run()`, which can already start jobs: a `job:start`
    // nobody heard is a slot the ledger would never count. `jobs:insert` is
    // heard on the legacy runner only, because each runner has its own LISTEN
    // client and every insert would otherwise be announced three times. See
    // slot-ledger.ts.
    const events: WorkerEvents = new EventEmitter();
    ledgerDetaches.push(
      attachSlotLedger(spec.id, events, {
        listenInserts: spec.legacy === true,
      }),
      // The run history rides the same emitter for the same reason: an event on
      // it is a run in one of this backend's slots. See run-stats.ts.
      attachRunStats(events),
    );

    started.push(
      await run(
        {
          // No `connectionString` here: graphile asserts the two are mutually
          // exclusive, and the shared pool is the whole point.
          pgPool,
          concurrency: spec.concurrency,
          events,
          // `onShutdown` stops every runner explicitly. Three runners each
          // installing their own process signal handlers would be three
          // independent shutdown paths racing one another.
          noHandleSignals: true,
          taskList,
        },
        // Hand graphile the live (initially empty) cron-item array; it re-reads
        // this reference each tick. Items are installed after the onAllReady
        // barrier via installScheduledCronItems(). Passing an explicit array also
        // skips graphile's crontab-file discovery.
        //
        // THE SHARPEST EDGE IN THIS FILE: the cron items go to ONE runner, and
        // the others get an empty array. graphile's cron scheduler is
        // per-runner, so three runners would be three schedulers ticking every
        // minute over the same crontab.
        //
        // Being precise about what that would and would not break, because the
        // temptation is to hand the same array to all three and see nothing go
        // wrong: graphile's `scheduleCronJobs` gates each insert on a
        // `_private_known_crontabs` upsert (`dist/cron.js`,
        // `where known_crontabs.last_execution < excluded.last_execution`) whose
        // documented purpose is exactly "jobs already scheduled via a different
        // Worker instance will be skipped". So the ticks would MOSTLY dedupe.
        // That is a guard to be grateful for, not a design to lean on — three
        // schedulers racing one row every minute for no gain, with correctness
        // resting on a race resolving the way it usually does.
        //
        // WHICH runner holds them does not affect where a tick RUNS — the tick
        // is an ordinary insert on the job's own class task, fetched by whatever
        // runner serves that class. It rides on `legacy` because that flag
        // already means "the one runner carrying the cross-cutting duties", so
        // the ladder has one such marker rather than two.
        undefined,
        spec.legacy ? scheduledCronItems : [],
      ),
    );
  }
  runners = started;
  return runners;
}

export async function stopWorkers(): Promise<void> {
  if (runners) {
    await Promise.all(runners.map((r) => r.stop()));
    runners = null;
  }
  // After the stop, not before: in-flight jobs still emit `job:complete` while
  // `stop()` drains them. What it does not drain — jobs a timed-out graceful
  // shutdown releases with `failJobs`, no `job:complete` — is why the ledger
  // is then cleared outright rather than trusted to have emptied itself.
  for (const detach of ledgerDetaches) detach();
  ledgerDetaches = [];
  clearSlotLedger();
  clearRunStats();
  if (workerUtilsPromise) {
    const utils = await workerUtilsPromise;
    await utils.release();
    workerUtilsPromise = null;
  }
  if (enqueuePool) {
    // Ours to create, ours to end — `utils.release()` never ends a pool it was
    // handed (graphile `dist/lib.js` `assertPool`: the `pgPool.end()` releaser
    // exists only in the branches that build the pool themselves).
    await enqueuePool.end();
    enqueuePool = null;
  }
  if (runnerPool) {
    // Ours to create, ours to end — graphile never ends a caller-supplied pool.
    await runnerPool.end();
    runnerPool = null;
  }
}

/**
 * A STANDING INVARIANT, not a one-shot migration: on every boot, every PENDING
 * row sits on the graphile task and priority that its `jobName`'s CURRENT hold
 * class declares.
 *
 * Written as an invariant so reclassifying a job is safe by construction — flip
 * a `defineJob({ hold })` and the rows already queued under the old class move
 * on the next boot, with nothing to remember and no migration to write. It is
 * also what carries rows across the deploy that introduced the classes: they
 * were all written on `LEGACY_JOB_TASK`.
 *
 * **Locked rows are untouched, deliberately.** `locked_at IS NULL` is the whole
 * guard. A locked row has a worker running it right now; moving it under the
 * running handler would be a write against live state for no benefit, and it is
 * already reachable (the legacy task lives in the wide runner). If it fails, its
 * retry lands re-pointed on the next boot. Nothing here infers anything from how
 * long a row has been locked — this is presence, not age. See the liveness
 * doctrine in this plugin's CLAUDE.md.
 */
async function repointHoldTasks(): Promise<void> {
  const namesByHold = new Map<HoldClass, string[]>(
    HOLD_CLASSES.map((hold) => [hold, [] as string[]]),
  );
  // The registry is fully populated at the register phase, which runs before
  // `onReady` — so every job this composition loads is already here.
  for (const job of jobRegistry.values()) {
    namesByHold.get(job.hold)?.push(job.name);
  }

  await runInBackgroundLane(async () => {
    // A `_private_tasks` row appears either on the first `add_job` for that
    // identifier, or when a runner starts and registers its own task list
    // (`dist/taskIdentifiers.js`: `insert into … _private_tasks … select
    // unnest($1::text[]) on conflict do nothing`). Both are LATER than this: the
    // re-point deliberately runs before any `run()`, so on a first boot the
    // class tasks do not exist yet and the join below would silently move
    // nothing. Minting them here is what makes the invariant hold on boot #1.
    //
    // The explicit `ARRAY[…]::text[]` constructor is not decoration: drizzle
    // expands a JS array inside a `sql` template into a comma-separated list of
    // bound params, which is right for `IN (…)` and malformed for anything
    // wanting ONE array value.
    await db.execute(sql`
      INSERT INTO graphile_worker._private_tasks (identifier)
      SELECT unnest(ARRAY[${sql.join(
        ALL_JOB_TASKS.map((t) => sql`${t}`),
        sql`, `,
      )}]::text[])
      ON CONFLICT DO NOTHING
    `);

    const moved: string[] = [];
    for (const hold of HOLD_CLASSES) {
      const names = namesByHold.get(hold) ?? [];
      if (names.length === 0) continue;
      const priority = priorityFor(hold);
      // One statement per class. `t` supplies the task's integer id by join
      // rather than by a re-typed subquery, and the last predicate keeps the
      // steady-state boot a no-op write. `RETURNING` + the returned row count
      // makes the moved count robust regardless of the driver's `rowCount` typing.
      const repointed = await executeRows(db, {
        label: `repointHoldTasks: ${hold}`,
        // `j.id` is `bigint`, which pg hands back as a string; `::text` says so.
        row: z.object({ id: z.string() }),
        query: sql`
        UPDATE graphile_worker._private_jobs j
           SET task_id = t.id, priority = ${priority}
          FROM graphile_worker._private_tasks t
         WHERE t.identifier = ${taskFor(hold)}
           AND j.locked_at IS NULL
           AND j.payload->>'jobName' IN (${sql.join(names, sql`, `)})
           AND (j.task_id <> t.id OR j.priority <> ${priority})
        RETURNING j.id::text AS id
      `,
      });
      if (repointed.length > 0) {
        moved.push(`${repointed.length} → ${hold}`);
      }
    }

    // Only ever published when rows actually moved, which after the deploy that
    // introduces a class is exactly "someone reclassified a job" — the one time
    // you want to see it. A steady-state boot is silent.
    if (moved.length > 0) {
      jobsLog.publish(
        `re-pointed pending rows onto hold tasks: ${moved.join(", ")}`,
      );
    }
  });
}

// Layer 1 failure policy: fail-loud. Unknown job or input-schema drift → throw;
// Graphile retries up to `maxAttempts`, then permanently-fails (row stays in
// `graphile_worker._private_jobs` with `attempts >= max_attempts`). A handler
// that knows its failure is DETERMINISTIC can throw a `NonRetryableError`
// instead: the catch below collapses the retry budget so the row dead-letters
// after a single attempt — loud, reported, and visible, but without burning
// `maxAttempts` retries of pure waste. Layer 1 itself has nothing to preserve —
// callers (like the events dispatcher) that want preservation semantics catch
// those conditions in their own handler.
async function dispatch(
  payload: JobTaskPayload,
  meta: {
    jobId: string;
    attempt: number;
    maxAttempts: number;
    runnerId: string;
  },
): Promise<void> {
  const job = UNSAFE_getRegisteredJob(payload.jobName);
  if (!job) {
    const err = new Error(`[jobs] unknown job "${payload.jobName}"`);
    reportServerError({ message: err.message, stack: err.stack ?? null });
    throw err;
  }
  // Validation only — DO NOT use `parsed.data` for the handler. The stored
  // payload was already transformed at enqueue time; re-using `parsed.data`
  // would re-run any `.transform()` in the schema on every retry/resume,
  // which yields divergent results for non-idempotent transforms (e.g.
  // `z.string().transform(s => s + "!")`). Contract: a job's input schema
  // is parsed exactly once, at the original `enqueue()`. The worker
  // re-validates only to catch schema drift after a redeploy.
  const validation = job.inputSchema.safeParse(payload.input);
  if (!validation.success) {
    const err = new Error(
      `[jobs] input schema drift for "${payload.jobName}": ${validation.error.message}`,
    );
    reportServerError({ message: err.message, stack: err.stack ?? null });
    throw err;
  }

  // One derivation for every row: a keyed dedup or resume row carries its run
  // id, everything else (singleton, none, cron tick) is its own row's run. See
  // `run-identity.ts`. The row id survives retries and sweeper reclaims, so a
  // retry still replays its own cached steps.
  const workflowRunId = workflowRunIdFor(payload, meta.jobId);

  // One controller per dispatch, not per job name and not per workflow: the unit
  // being bounded is a single run holding a single worker slot. A suspended
  // workflow resumes as a different `_private_jobs` row through a fresh
  // `dispatch()`, and so gets a fresh controller — which is what makes "the
  // budget bounds execution, not workflow duration" true by construction rather
  // than by convention.
  //
  // What aborts it: a timer armed below for this job's hold-class deadline
  // (`deadlineMsFor`). At that instant the signal aborts with a
  // `JobDeadlineExceededError` and the overrun is reported — and that is ALL
  // that happens. The wrapper does not return, the advisory lock is not
  // released, and the row is not touched, so a handler that ignores the signal
  // can cost at most its own slot and can never be re-dispatched alongside
  // itself. See deadline.ts for why there is no `Promise.race` anywhere.
  //
  // Deliberately NOT graphile's `helpers.abortSignal` — see the doc on
  // `JobCtx.signal`.
  const abort = new AbortController();

  const ctx = makeDurableCtx({
    jobId: meta.jobId,
    attempt: meta.attempt,
    workflowRunId,
    signal: abort.signal,
    jobName: payload.jobName,
    originalInput: payload.input,
    scheduleResume,
  });

  // Hold this job's advisory lock for exactly the handler's lifetime, so that for
  // as long as this handler runs the database itself can answer "a worker is still
  // on this row" — and answer it correctly for a 200 ms handler and a six-hour one
  // alike, because the answer is shared fate with this backend rather than the age
  // of a timestamp. `withJobLock` releases on every exit path (success, suspend,
  // throw), after which graphile owns the row's terminal transition. See
  // job-lock.ts for why this is a dedicated direct-5433 connection.
  //
  // Keyed on the graphile job id, never `workflowRunId`: a suspended workflow
  // resumes as a DIFFERENT `_private_jobs` row, so a run-scoped key would make the
  // resumed step contend with the very predecessor whose suspension created it.
  const outcome = await withJobLock(
    meta.jobId,
    (err) => {
      // The lock's connection died while the handler is still running: the lock is
      // gone, so nothing now prevents the sweeper from reclaiming this row and
      // graphile from re-dispatching it alongside the live handler. We cannot
      // un-run a handler mid-flight — all we can do is make the double-run window
      // impossible to miss.
      const errObj = err instanceof Error ? err : new Error(String(err));
      const message = `[jobs] lock connection lost mid-handler for ${payload.jobName} (job ${meta.jobId}): ${errObj.message} — job may double-run`;
      console.warn(message, errObj);
      reportServerError({
        message,
        stack: errObj.stack ?? null,
        errorType: errObj.name,
      });
    },
    async (): Promise<"completed" | "suspended"> => {
      // Armed INSIDE the lock closure, deliberately: the clock must measure the
      // handler's run, not the time spent acquiring the lock, and the lock must
      // stay held for the handler's real lifetime including its overrun.
      const disarm = armDeadline({
        jobName: payload.jobName,
        jobId: meta.jobId,
        attempt: meta.attempt,
        hold: job.hold,
        runnerId: meta.runnerId,
        abort,
      });
      try {
        await recordEntrySpan("job", payload.jobName, () =>
          job.run({ input: payload.input, event: payload.event, ctx }),
        );
        // A handler that SUCCEEDS after its signal was aborted keeps its
        // success. It did the work; re-running it would be waste and, for a
        // non-idempotent handler, harm. The overrun is not lost — the deadline
        // timer already reported it, which is the signal we actually need.
        return "completed";
      } catch (err) {
        if (isSuspendSignal(err)) {
          // Graphile sees a successful run — the current job completes and the
          // row is deleted. Resume happens via a fresh `enqueue` issued by
          // `jobs.resume` when the event fires or the timeout hits. Reported as a
          // value rather than an early `return` from `dispatch`, because inside
          // this closure a `return` would only exit the closure and would let the
          // step/wait-log cleanup below run on a workflow that is still live.
          return "suspended";
        }
        const errObj = err instanceof Error ? err : new Error(String(err));
        reportServerError({
          message: `[jobs] ${payload.jobName} failed (attempt ${meta.attempt}): ${errObj.message}`,
          stack: errObj.stack ?? null,
          errorType: errObj.name,
        });
        // A NonRetryableError signals a DETERMINISTIC failure — the same stored
        // input will fail identically on every retry. Collapse the retry budget so
        // graphile dead-letters this row after the current attempt instead of
        // churning `maxAttempts` retries of pure waste. The throw below still feeds
        // graphile's fail handler (sets last_error, clears the lock); the row then
        // satisfies `deadJobPredicate` and queue-health reaps it as one dead-letter.
        // If the budget-collapse write itself fails, we fall through to the throw
        // and graphile retries normally (the real cause was already reported above).
        //
        // The `job` entry span above wraps only `job.run()`, so this write lands with
        // no ambient entry and would be classified context-less — hence ungated,
        // running against the connections reserved for human-blocking work. Widening
        // the span would corrupt the recorded job duration; declaring the lane is the
        // right tool. See research/2026-07-09-global-interactive-lane-origin-based-db-gating.md.
        //
        // A run aborted by its own deadline is treated the same way from the
        // SECOND attempt on. The first failure could still be a slow moment —
        // a congested gate, a host under load — and deserves its retry. A
        // second run of the same stored input that also overran is a property
        // of the handler, not of the day, and retrying it three more times
        // spends `maxAttempts × deadline` of slot time to learn nothing. So it
        // dead-letters here, loudly, through the same machinery.
        const finality = classifyFailure({
          err,
          deadlineAborted: abort.signal.aborted,
          attempt: meta.attempt,
          maxAttempts: meta.maxAttempts,
        });
        if (finality.collapseBudget) {
          await runInBackgroundLane(() => markJobPermanentlyFailed(meta.jobId));
        }
        // The workflow is over — no attempt of it will ever run again — so its
        // step and wait logs go with it. For a keyed dedup that is a
        // CORRECTNESS matter, not tidiness: its run id is `${jobName}:${key}`,
        // so the NEXT enqueue with that key is the SAME workflow id. Left
        // behind, a cached `_jobSteps` row makes `ctx.step` return a result for
        // work the new run never did, and a `resolved` `_jobWaits` row makes
        // `ctx.waitFor` return a stale payload instantly instead of suspending.
        // A row-derived run id (`${jobName}:job:${jobId}`) is never reused, so
        // there it only stops the log leaking.
        //
        // Ordered AFTER the budget collapse and gated on `workflowDead`, which
        // is the whole safety argument: replay of cached steps on a RETRY is a
        // deliberate feature, so nothing is dropped while another attempt could
        // still legitimately use it. If the collapse write above rejects we
        // never get here, and graphile retries with the log intact.
        if (finality.workflowDead) await discardWorkflowLog(workflowRunId);
        throw err;
      } finally {
        // Both timers cleared on every exit path — success, suspend, failure.
        // A handler that settles in time therefore costs nothing but this.
        disarm();
      }
    },
  );

  if (outcome === LOCK_HELD) {
    // Another live session provably holds this job's lock, i.e. graphile handed
    // the same row to two workers. Under this design that should be
    // near-impossible, which is exactly why it is reported rather than logged: a
    // silent defer is how the original double-run bug hid for three months.
    //
    // Throwing (rather than returning) is the point — a successful return would
    // delete the row and silently DROP this tick. The throw feeds graphile's
    // normal fail path, so the row is re-queued with backoff and the other
    // worker's run is left undisturbed.
    const err = new Error(
      `[jobs] ${payload.jobName} (job ${meta.jobId}) is already locked by another live worker — deferring this dispatch`,
    );
    console.warn(err.message);
    reportServerError({ message: err.message, stack: err.stack ?? null });
    throw err;
  }
  if (outcome === "suspended") {
    // graphile will report this run as a success; the run history must not.
    markRunSuspended(meta.jobId);
    return;
  }

  // Normal completion: drop the step + wait logs for this run. The same
  // teardown the permanently-failed path above takes, on the same never-throw
  // terms — see `discardWorkflowLog` for both.
  await discardWorkflowLog(workflowRunId);
}
