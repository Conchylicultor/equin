import { z } from "zod";
import {
  abortDurableRun,
  defineJob,
  isNonRetryableError,
  type JobCtx,
  type JobFactory,
  type ScheduleSpec,
} from "@plugins/infra/plugins/jobs/server";
import type { LogChannel } from "@plugins/primitives/plugins/log-channels/server";
import type { RunTerminal } from "../../core";
import {
  applyFailurePolicy,
  builtinKindIdFor,
  builtinLedgerFor,
  JOB_WIDE_LOCK_KEY,
  readRecordedFailure,
  type RecordedFailure,
} from "./builtin-ledger";
import { finishSupervisedRun } from "./finish";
import { superviseRuns, type RunVerdict } from "./loop";
import {
  defineRunBodyTask,
  type RunBodyTask,
  type SupervisedRunContext,
} from "./run-body";
import {
  defineSupervisedRunKind,
  type SupervisedRunKind,
  type UnfinishedRun,
} from "./run/registry";
import { startSupervisedRun } from "./run/supervisor";
import { spawnClaimedRun } from "./spawn-claimed";
import { runStepsBody, type RunStep, type SupervisedJobSpawn } from "./steps";
import { runEnded } from "./tables-run-ended";

export type { SupervisedJobSpawn, SupervisedRunContext };

/** What the wrapper can tell `claim` about the workflow doing the claiming. */
export interface SupervisedJobClaimMeta {
  /**
   * The durable identity of the workflow that will own this run until its
   * outcome is recorded. A ledger that records it can attribute a row still open
   * with no live workflow behind it. Ignoring it is fine.
   */
  readonly workflowRunId: string;
  /** 1-indexed spawn attempt within the workflow — always 1 for `steps`. */
  readonly attempt: number;
}

/** What `onEnded` is told beyond the run's own identity and outcome. */
export interface SupervisedJobEndedMeta<I> {
  /** The input this workflow was enqueued with. */
  readonly input: I;
  /** 1-indexed spawn attempt — always 1 unless the job declared `runAttempts`. */
  readonly attempt: number;
  /**
   * The run failed because `cancelSupervisedJobByLock` stopped it — a user's
   * Cancel, not a fault. False for every other ending, including a run that
   * finished (exit 0) before the cancel's signal reached it, and a TERM sent
   * any other way (a reboot, `cancelSupervisedJob`). Always false with an own
   * ledger: cancel-by-lock is a built-in-ledger verb.
   */
  readonly cancelled: boolean;
}

/**
 * A job's OWN ledger: the table it records its runs in, as the five verbs the
 * primitive needs. For a job with a domain and a UI of its own — build,
 * release, backup, deploy — whose runs are data in that domain
 * (federation, not a shared table).
 *
 * Omit it and the job uses the built-in `supervised_job_runs` ledger instead.
 */
export interface SupervisedJobLedger<I> {
  /**
   * The supervised-run kind id, and the filename prefix of every artifact the
   * job writes. Lowercase alphanumeric, no separator.
   */
  readonly kindId: string;
  /**
   * Mint this run's ledger row and answer its id, or `null` when the claim lost
   * its race.
   *
   * **The claiming INSERT is the lock** — a partial unique index on the job's
   * own scope `WHERE finished_at IS NULL` decides, so a check-then-act before
   * the insert has a TOCTOU window. Seed the row with `process.pid` so it does
   * not read as an orphan before the child's pid is known.
   *
   * May instead ADOPT a row the caller already inserted (deploy claims in its
   * endpoint so a busy server answers 409 on the click): answer its id, or
   * `null` when that row is already closed.
   *
   * Runs inside a memoized step, so exactly once per attempt.
   */
  claim(input: I, meta: SupervisedJobClaimMeta): Promise<string | null>;
  /**
   * Every run of this job that has not been stamped with an outcome, in THIS
   * namespace. A worktree DB is a fork of main's, so an unscoped read would
   * reap another machine's runs.
   */
  listUnfinished(): Promise<readonly UnfinishedRun[]>;
  /** Record the pid of the process now serving `runId`. */
  setPid(runId: string, pid: number): Promise<void>;
  /**
   * Stamp this run's row with its terminal outcome **if it is still open** —
   * `WHERE finished_at IS NULL`, and nothing else.
   *
   * A bare write, called from the reconciler of every backend that sees the run
   * end, from the retry ladder before the next claim, and after a spawn that
   * never started a child. So: idempotent, first-writer-wins, no side effects.
   * Side effects belong in `onEnded` (or, for `steps`, in the body).
   */
  closeRow(runId: string, terminal: RunTerminal): Promise<void>;
  /**
   * `steps` only: step `step` of run `runId` is about to spawn. Record which
   * child a restarted backend should look for, and answer `false` when the run
   * was closed meanwhile — the step then spawns nothing and the body gets
   * `{ state: "run-closed" }`.
   */
  beginStep?(runId: string, step: string): Promise<boolean>;
  /**
   * A run this process did not start has been adopted: rebuild whatever
   * in-memory live view the job keeps for it. Only for a job holding one.
   */
  onReattach?(runId: string): void;
}

/** What a `steps` body is handed. */
export interface SupervisedStepsContext {
  /** The run id `ledger.claim` answered. */
  readonly runId: string;
  /** Spawn one child and wait for it — see `runStepsBody` in `steps.ts`. */
  readonly step: RunStep;
  /** The job context, for waits the body needs between steps. */
  readonly ctx: JobCtx;
}

/** Everything every supervised job declares, whatever runs. */
interface SupervisedJobBase<N extends string, S extends z.ZodType> {
  /** Job name, as it appears in the queue (`build.run.supervised`). */
  name: N;
  /**
   * What this job does and why, in one present-tense sentence a user reads —
   * forwarded to `defineJob`'s `description` (see its doc for the rules).
   */
  description: string;
  /** Schema for the value `.enqueue()` takes. Parsed once, at enqueue. */
  input: S;
  /** Where the supervisor publishes the children's live output. */
  channel: LogChannel;
  /**
   * Run on a recurring schedule. The job then becomes `dedup: "singleton"`
   * (one pending row) with the cron; the cron payload is `input.parse({})`.
   * Absent, the job is `dedup: "none"`, because a pending singleton row takes
   * the LATEST payload, which would merge two distinct requests.
   */
  schedule?: ScheduleSpec;
}

/** The two bodies that run ONE child per attempt. */
interface SingleChildCommon<S extends z.ZodType> {
  /**
   * How many children may be spawned in sequence while the run keeps failing.
   * Default **1**. Each attempt is a NEW run (new id, transcript, marker), with
   * a durable backoff between them. Raise it only for work whose failures are
   * transient AND whose partial effects are safe to repeat.
   */
  runAttempts?: number;
  /**
   * The run ENDED — do the terminal WORK: a notification, a convergence
   * reconcile, data beyond the outcome. The row is already closed by
   * `closeRow` in the ordinary case, so read it back rather than gating on it.
   *
   * **Idempotent**, because it is not memoized: it re-runs for every earlier
   * attempt on a replay. Throwing fails the job.
   *
   * With the built-in ledger, the failure policy runs right after it (see
   * `applyFailurePolicy`).
   */
  onEnded?(
    runId: string,
    terminal: RunTerminal,
    meta: SupervisedJobEndedMeta<z.infer<S>>,
  ): Promise<void>;
  hold?: never;
  steps?: never;
}

/** A child named by a command line — build, release. */
interface ArgvBody<S extends z.ZodType> {
  /**
   * The command to supervise for this run. May be async (an environment
   * assembled from contributions — secrets that must NOT travel through
   * `input`, which is persisted verbatim). Resolved inside the spawn step.
   */
  argv(
    input: z.infer<S>,
    runId: string,
  ): SupervisedJobSpawn | Promise<SupervisedJobSpawn>;
  run?: never;
}

/** A child that runs in-process code — backup, the reaper, the fork. */
interface RunBody<S extends z.ZodType> {
  /**
   * The work, run in its own process: `./equin supervised-exec <name>`
   * boots the plugin graph in `exec` mode and calls this with the job's input.
   * Contributions, config and the database are all present, exactly as in the
   * backend. `log` writes to the transcript.
   *
   * With the built-in ledger, a throw records `error_message` and `retryable`
   * (false for a `NonRetryableError`) on the run's row before the child exits 1.
   */
  run(input: z.infer<S>, ctx: SupervisedRunContext): Promise<void>;
  argv?: never;
}

/** Where a single-child job records its runs. */
type LedgerChoice<S extends z.ZodType> =
  | {
      ledger: SupervisedJobLedger<z.infer<S>>;
      /** Only the built-in ledger locks by key; an own ledger's claim IS its lock. */
      lock?: never;
    }
  | {
      ledger?: undefined;
      /**
       * Built-in ledger only: what one run excludes. Two runs whose inputs give
       * the same key never run at once. Omitted, the whole job is one lock.
       */
      lock?: (input: z.infer<S>) => string;
    };

/** Several children, sequenced in the backend — deploy. */
interface StepsBody<S extends z.ZodType> {
  /**
   * A durable workflow in the backend that runs children one at a time through
   * `step`, suspending between them (no slot held while a child runs). The
   * wrapper passes suspend signals through untouched and releases the
   * workflow's suspension state when the body returns (or throws a
   * `NonRetryableError`).
   *
   * A step whose spawn started no child answers `not-started`: record the
   * verdict in your own words. Once the body is done, the wrapper closes any
   * such child's row that is still open, with the hard-kill sentinel.
   */
  steps(input: z.infer<S>, ctx: SupervisedStepsContext): Promise<void>;
  /**
   * Required: the built-in ledger closes a run when its ONE child ends, which
   * is not what a sequence is.
   */
  ledger: SupervisedJobLedger<z.infer<S>>;
  /**
   * What bounds the backend code between steps. Default `instant`; `seconds`
   * when a body does a timed read between steps. Never `minutes` — long work is
   * a step.
   */
  hold?: "instant" | "seconds";
  argv?: never;
  run?: never;
  lock?: never;
  /** A sequence decides its own retries. */
  runAttempts?: never;
  /** The body sees every step's terminal; there is no single one to hand here. */
  onEnded?: never;
}

/**
 * What a supervised job declares.
 *
 * Exactly one of `argv` / `run` / `steps`; a single-child body takes an own
 * `ledger` or the built-in one (optionally with `lock`); `steps` requires an
 * own ledger and forbids `runAttempts`; `hold` exists only for `steps` and is
 * never `minutes`. Every other combination is a tsc error.
 */
export type DefineSupervisedJobSpec<
  N extends string,
  S extends z.ZodType,
> = SupervisedJobBase<N, S> &
  (
    | (SingleChildCommon<S> & (ArgvBody<S> | RunBody<S>) & LedgerChoice<S>)
    | StepsBody<S>
  );

/**
 * A registered supervised job. One `register:` token mounts the queue job, the
 * supervised-run kind and, for a `run` body, the child task.
 */
export interface SupervisedJob<
  N extends string,
  S extends z.ZodType,
> extends JobFactory<N, S, z.ZodNever> {
  /** The supervised-run kind this job owns (for `cancelSupervisedJob`). */
  readonly kind: SupervisedRunKind;
}

/**
 * What `cancelSupervisedJobByLock` needs of a job: its built-in ledger and the
 * `lock` it declared. Held off the public `SupervisedJob` type so the cancel
 * verb is the only reader; a job missing here has an own ledger or no `lock`.
 */
export interface BuiltinLockedJob {
  readonly jobName: string;
  readonly lock: (input: unknown) => string;
}

const builtinLockedJobs = new WeakMap<object, BuiltinLockedJob>();

/** The built-in ledger and lock of `job`, or `null` when it has none. */
export function builtinLockedJobOf(job: object): BuiltinLockedJob | null {
  return builtinLockedJobs.get(job) ?? null;
}

/** A ledger with the verbs the wrapper calls, whichever kind it is. */
interface ResolvedLedger<I> {
  readonly kindId: string;
  readonly builtin: boolean;
  claim(input: I, meta: SupervisedJobClaimMeta): Promise<string | null>;
  listUnfinished(): Promise<readonly UnfinishedRun[]>;
  setPid(runId: string, pid: number): Promise<void>;
  closeRow(runId: string, terminal: RunTerminal): Promise<void>;
  beginStep?: (runId: string, step: string) => Promise<boolean>;
  onReattach?: (runId: string) => void;
}

function resolveLedger<N extends string, S extends z.ZodType>(
  spec: DefineSupervisedJobSpec<N, S>,
): ResolvedLedger<z.infer<S>> {
  const own = spec.ledger;
  if (own !== undefined) {
    return {
      kindId: own.kindId,
      builtin: false,
      claim: (input, meta) => own.claim(input, meta),
      listUnfinished: () => own.listUnfinished(),
      setPid: (runId, pid) => own.setPid(runId, pid),
      closeRow: (runId, terminal) => own.closeRow(runId, terminal),
      ...(own.beginStep === undefined
        ? {}
        : {
            beginStep: (runId: string, step: string) =>
              own.beginStep!(runId, step),
          }),
      ...(own.onReattach === undefined
        ? {}
        : { onReattach: (runId: string) => own.onReattach!(runId) }),
    };
  }
  const builtin = builtinLedgerFor(spec.name);
  const lock = spec.steps === undefined ? spec.lock : undefined;
  return {
    kindId: builtinKindIdFor(spec.name),
    builtin: true,
    claim: (input, meta) =>
      builtin.claim({
        lockKey: lock === undefined ? JOB_WIDE_LOCK_KEY : lock(input),
        attempt: meta.attempt,
        workflowRunId: meta.workflowRunId,
      }),
    listUnfinished: builtin.listUnfinished,
    setPid: builtin.setPid,
    closeRow: builtin.closeRow,
  };
}

/**
 * Declare a job whose body runs in processes that outlive the backend that
 * started them — the one way to start a detached child.
 *
 * ```ts
 * export const forkJob = defineSupervisedJob({
 *   name: "database.fork",
 *   input: z.object({ target: z.string() }),
 *   channel: forkLog,
 *   lock: (input) => input.target,
 *   runAttempts: 5,
 *   run: async (input, { log }) => { … },
 * });
 * ```
 *
 * Mounted with `register: [forkJob]`, started with `forkJob.enqueue(input)`.
 * What each part is load-bearing for is in this plugin's CLAUDE.md.
 *
 * `hold` is `instant` for a single-child job and not a consumer's to choose:
 * one dispatch claims, spawns detached and suspends — milliseconds.
 */
export function defineSupervisedJob<N extends string, S extends z.ZodType>(
  spec: DefineSupervisedJobSpec<N, S>,
): SupervisedJob<N, S> {
  const ledger = resolveLedger(spec);

  const kind = defineSupervisedRunKind({
    id: ledger.kindId,
    channel: spec.channel,
    listUnfinished: ledger.listUnfinished,
    setPid: ledger.setPid,
    ...(ledger.onReattach === undefined
      ? {}
      : { onReattach: ledger.onReattach }),
    // Close the row, then say the run ended — and nothing else. The outcome
    // does not travel with the announcement (see `RunEndedPayload`); the
    // workflow re-reads the marker.
    finish: (runId, terminal) =>
      finishSupervisedRun(
        {
          closeRow: ledger.closeRow,
          announce: (id) => runEnded.emit({ kindId: ledger.kindId, runId: id }),
        },
        runId,
        terminal,
      ),
  });

  let task: RunBodyTask | null = null;
  let hold: "instant" | "seconds" = "instant";
  let run: (args: { input: z.infer<S>; ctx: JobCtx }) => Promise<void>;

  if (spec.steps !== undefined) {
    hold = spec.hold ?? "instant";
    const body = spec.steps;
    run = ({ input, ctx }) => runStepsJob(body, kind, ledger, input, ctx);
  } else {
    const runAttempts = spec.runAttempts ?? 1;
    if (!Number.isInteger(runAttempts) || runAttempts < 1) {
      throw new Error(
        `[supervised-job] ${spec.name}: runAttempts must be a positive integer, got ${String(spec.runAttempts)}`,
      );
    }
    let command: (
      input: z.infer<S>,
      runId: string,
      attempt: number,
    ) => Promise<SupervisedJobSpawn>;
    if (spec.run !== undefined) {
      const runTask = defineRunBodyTask({
        name: spec.name,
        input: spec.input,
        run: spec.run,
        recordErrors: ledger.builtin,
      });
      task = runTask;
      command = (input, runId, attempt) =>
        Promise.resolve(runTask.invoke({ runId, attempt, input }));
    } else {
      const argv = spec.argv;
      command = async (input, runId) => await argv(input, runId);
    }
    const onEnded = spec.onEnded;
    run = ({ input, ctx }) =>
      runSingleChildJob({
        jobName: spec.name,
        kind,
        ledger,
        runAttempts,
        command,
        onEnded,
        input,
        ctx,
      });
  }

  const common = {
    name: spec.name,
    description: spec.description,
    factory: "defineSupervisedJob",
    hold,
    input: spec.input,
    event: z.never(),
    run,
  };
  const job =
    spec.schedule !== undefined
      ? defineJob({
          ...common,
          dedup: "singleton",
          schedule: spec.schedule,
        })
      : defineJob({ ...common, dedup: "none" });

  const supervised: SupervisedJob<N, S> = {
    ...job,
    kind,
    _kind: "supervised-job",
    _factory: "defineSupervisedJob",
    _doc: { label: spec.name, detail: spec.description },
    async register() {
      // The kind first: the supervisor asserts its kind is registered, and all
      // three writes happen in the register phase, before any `onReady` — which
      // is what lets the single reconciler see every kind. The task is what
      // `supervised-exec` resolves in the child, so it is registered in the
      // child's own register phase by this same token.
      await kind.register();
      if (task !== null) await task.register();
      await job.register();
    },
  };
  if (ledger.builtin && spec.steps === undefined && spec.lock !== undefined) {
    const lock = spec.lock;
    builtinLockedJobs.set(supervised, {
      jobName: spec.name,
      // The caller hands `z.infer<S>` (the cancel verb's signature), the same
      // parsed shape `claim` locked on.
      lock: (input) => lock(input as z.infer<S>),
    });
  }
  return supervised;
}

async function runSingleChildJob<I>(opts: {
  jobName: string;
  kind: SupervisedRunKind;
  ledger: ResolvedLedger<I>;
  runAttempts: number;
  command: (
    input: I,
    runId: string,
    attempt: number,
  ) => Promise<SupervisedJobSpawn>;
  onEnded:
    | ((
        runId: string,
        terminal: RunTerminal,
        meta: SupervisedJobEndedMeta<I>,
      ) => Promise<void>)
    | undefined;
  input: I;
  ctx: JobCtx;
}): Promise<void> {
  const { kind, ledger, input, ctx } = opts;
  let result;
  try {
    result = await superviseRuns({
      kind,
      runAttempts: opts.runAttempts,
      ctx,
      spawn: async (attempt) => {
        const runId = await ledger.claim(input, {
          workflowRunId: ctx.workflowRunId,
          attempt,
        });
        if (runId === null) return null;
        const command = await opts.command(input, runId, attempt);
        // From here the ledger row exists, so a failing spawn must not leave it
        // open — an unfinished row IS the job's lock. See `spawnClaimedRun`.
        const { pid } = await spawnClaimedRun(
          {
            start: () =>
              startSupervisedRun(kind, {
                runId,
                argv: command.argv,
                cwd: command.cwd,
                envOverrides: command.envOverrides,
              }),
            closeRow: ledger.closeRow,
          },
          runId,
        );
        return { runId, pid };
      },
      closeRow: ledger.closeRow,
      onEnded: (started, terminal, attempt) =>
        endAttempt({
          jobName: opts.jobName,
          builtin: ledger.builtin,
          runAttempts: opts.runAttempts,
          readFailure: readRecordedFailure,
          onEnded: opts.onEnded,
          runId: started.runId,
          terminal,
          attempt,
          input,
        }),
    });
  } catch (err) {
    // A dead-lettering failure (the built-in failure policy, or an `onEnded`
    // declaring its own failure deterministic) ends this workflow for good, so
    // release its suspension state on the way out, exactly as a recorded
    // outcome does below. Anything else — a suspend signal, a transient error
    // the retry will replay — passes through with the workflow intact.
    if (isNonRetryableError(err)) await abortDurableRun(ctx.workflowRunId);
    throw err;
  }

  if (result.outcome === "not-claimed") return;

  // The run is over and its outcome recorded, so nothing should resume this
  // workflow again — release a wait some iteration armed and then skipped.
  await abortDurableRun(ctx.workflowRunId);

  // **With an own ledger, a non-zero exit code is DATA, not an exception**: the
  // failed run surfaces in the job's own row, UI and notification, and a throw
  // would file a dead-letter for every failed build. The built-in ledger has no
  // UI, so its failure policy (in `onEnded` above) throws instead.
}

/**
 * One single-child attempt has ended: run the job's `onEnded`, then answer the
 * ladder's verdict.
 *
 * - Own ledger: the exit code decides (a failed run is DATA in the job's own
 *   row, retried while attempts are left). `cancelled` is always false.
 * - Built-in ledger: a failed run's row is read FIRST, so `onEnded` can tell a
 *   user's Cancel from a fault, and the failure policy answers (or throws).
 */
export async function endAttempt<I>(opts: {
  jobName: string;
  builtin: boolean;
  runAttempts: number;
  readFailure: (runId: string) => Promise<RecordedFailure>;
  onEnded:
    | ((
        runId: string,
        terminal: RunTerminal,
        meta: SupervisedJobEndedMeta<I>,
      ) => Promise<void>)
    | undefined;
  runId: string;
  terminal: RunTerminal;
  attempt: number;
  input: I;
}): Promise<RunVerdict> {
  const { runId, terminal, attempt } = opts;
  const failure =
    opts.builtin && terminal.exitCode !== 0
      ? await opts.readFailure(runId)
      : null;
  await opts.onEnded?.(runId, terminal, {
    input: opts.input,
    attempt,
    cancelled: failure?.cancelled ?? false,
  });
  if (!opts.builtin) return terminal.exitCode === 0 ? "done" : "retry";
  return applyFailurePolicy({
    jobName: opts.jobName,
    runId,
    terminal,
    attempt,
    runAttempts: opts.runAttempts,
    failure,
  });
}

async function runStepsJob<I>(
  body: (input: I, ctx: SupervisedStepsContext) => Promise<void>,
  kind: SupervisedRunKind,
  ledger: ResolvedLedger<I>,
  input: I,
  ctx: JobCtx,
): Promise<void> {
  const runId = await ctx.step("claim", () =>
    ledger.claim(input, { workflowRunId: ctx.workflowRunId, attempt: 1 }),
  );
  if (runId === null) return;

  try {
    await runStepsBody({
      ctx,
      kind,
      runId,
      beginStep: ledger.beginStep,
      closeRow: ledger.closeRow,
      listUnfinished: ledger.listUnfinished,
      start: (childId, spawn) =>
        startSupervisedRun(kind, {
          runId: childId,
          argv: spawn.argv,
          cwd: spawn.cwd,
          envOverrides: spawn.envOverrides,
        }),
      body: (step) => body(input, { runId, step, ctx }),
    });
  } catch (err) {
    // A suspend signal passes through untouched (`runStepsBody` rethrows it
    // first). A body error fails the job; one declaring itself deterministic
    // ends the workflow for good, so its suspension state is released exactly
    // as a returning body's is below. Anything else keeps it for the retry.
    if (isNonRetryableError(err)) await abortDurableRun(ctx.workflowRunId);
    throw err;
  }
  await abortDurableRun(ctx.workflowRunId);
}
