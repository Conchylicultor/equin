import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import {
  isNonRetryableError,
  NonRetryableError,
} from "@plugins/infra/plugins/jobs/server";
import {
  assertRunKindId,
  SUPERVISED_EXIT_TEMPFAIL,
  type RunTerminal,
} from "../../core";
import type { UnfinishedRun } from "./run/registry";
import { _supervisedJobRuns, SUPERVISED_JOB_RUNS_INFLIGHT_UQ } from "./tables";

/**
 * The lock key of a job that declared no `lock`: every run of the job contends
 * on this one value, so at most one runs at a time. A constant rather than the
 * run id, because "no lock" on a reaper means "don't sweep twice at once", not
 * "no exclusion at all".
 */
export const JOB_WIDE_LOCK_KEY = "*";

/**
 * The supervised-run kind id of a built-in-ledger job, derived from its name:
 * `database.fork` → `databasefork`, `worktree-cleanup.reap-stale` →
 * `worktreecleanupreapstale`.
 *
 * Asserted rather than trusted — a kind id is a filename prefix, so it must be
 * lowercase alphanumeric starting with a letter. A name that derives to
 * something else (`1password.sync`) throws at definition, and two names that
 * derive to the same id throw at register (the kind registry refuses a
 * duplicate id).
 */
export function builtinKindIdFor(jobName: string): string {
  const id = jobName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  assertRunKindId(id);
  return id;
}

/**
 * node-postgres surfaces a unique violation as SQLSTATE 23505 plus the
 * offending constraint. The constraint is checked, not just the code: a
 * primary-key collision reported as "already running" would be a
 * plausible-looking lie about a different fault.
 */
export function isInflightViolation(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string } | null;
  return (
    pg?.code === "23505" && pg.constraint === SUPERVISED_JOB_RUNS_INFLIGHT_UQ
  );
}

/**
 * The built-in ledger's verbs, bound to one job. Every verb takes the database
 * handle at construction so the claim lock can be driven against a throwaway
 * database in a test.
 */
export function builtinLedgerFor(
  jobName: string,
  conn: NodePgDatabase = db,
): {
  claim(meta: {
    lockKey: string;
    attempt: number;
    workflowRunId: string;
  }): Promise<string | null>;
  listUnfinished(): Promise<readonly UnfinishedRun[]>;
  setPid(runId: string, pid: number): Promise<void>;
  closeRow(runId: string, terminal: RunTerminal): Promise<void>;
  markCancelled(lockKey: string): Promise<string | null>;
  latest(lockKey: string): Promise<SupervisedRunRow | null>;
} {
  return {
    /**
     * INSERT the row; the partial unique index answers the race. Seeded with
     * this backend's pid so the fresh row is not an orphan before the child's
     * pid is known.
     */
    async claim({ lockKey, attempt, workflowRunId }) {
      const runId = crypto.randomUUID();
      try {
        await conn.insert(_supervisedJobRuns).values({
          id: runId,
          jobName,
          lockKey,
          pid: process.pid,
          attempt,
          workflowRunId,
        });
        return runId;
      } catch (err) {
        if (isInflightViolation(err)) return null;
        throw err;
      }
    },

    async listUnfinished() {
      const rows = await conn
        .select({ id: _supervisedJobRuns.id, pid: _supervisedJobRuns.pid })
        .from(_supervisedJobRuns)
        .where(
          and(
            eq(_supervisedJobRuns.jobName, jobName),
            isNull(_supervisedJobRuns.finishedAt),
          ),
        );
      return rows.map((row) => ({ runId: row.id, pid: row.pid }));
    },

    async setPid(runId, pid) {
      await conn
        .update(_supervisedJobRuns)
        .set({ pid })
        .where(eq(_supervisedJobRuns.id, runId));
    },

    /** Bare, idempotent, first-writer-wins: the only writer of the outcome. */
    async closeRow(runId, terminal) {
      await conn
        .update(_supervisedJobRuns)
        .set({
          finishedAt: terminal.finishedAt,
          exitCode: terminal.exitCode,
          signalCode: terminal.signalCode,
        })
        .where(
          and(
            eq(_supervisedJobRuns.id, runId),
            isNull(_supervisedJobRuns.finishedAt),
          ),
        );
    },

    /**
     * Stamp `cancelled_at` on the open run holding `lockKey` and answer its id,
     * or `null` when no run of this job holds it. The partial unique index
     * guarantees at most one such row. The first stamp wins, so a second
     * cancel keeps the time the user first asked.
     */
    async markCancelled(lockKey) {
      const [row] = await conn
        .update(_supervisedJobRuns)
        .set({
          cancelledAt: sql`COALESCE(${_supervisedJobRuns.cancelledAt}, now())`,
        })
        .where(
          and(
            eq(_supervisedJobRuns.jobName, jobName),
            eq(_supervisedJobRuns.lockKey, lockKey),
            isNull(_supervisedJobRuns.finishedAt),
          ),
        )
        .returning({ id: _supervisedJobRuns.id });
      return row?.id ?? null;
    },

    /** The newest run of this job under `lockKey`, open or closed. */
    async latest(lockKey) {
      const [row] = await conn
        .select({
          id: _supervisedJobRuns.id,
          startedAt: _supervisedJobRuns.startedAt,
          finishedAt: _supervisedJobRuns.finishedAt,
          exitCode: _supervisedJobRuns.exitCode,
          errorMessage: _supervisedJobRuns.errorMessage,
        })
        .from(_supervisedJobRuns)
        .where(
          and(
            eq(_supervisedJobRuns.jobName, jobName),
            eq(_supervisedJobRuns.lockKey, lockKey),
          ),
        )
        .orderBy(desc(_supervisedJobRuns.startedAt))
        .limit(1);
      if (row === undefined) return null;
      return {
        id: row.id,
        startedAt: row.startedAt,
        open: row.finishedAt === null,
        exitCode: row.exitCode,
        errorMessage: row.errorMessage,
      };
    },
  };
}

/**
 * One built-in-ledger run, as a caller waiting on the job reads it back —
 * see `latestSupervisedRun`.
 */
export interface SupervisedRunRow {
  /** The run id: what `runEnded` names, with the job's `kind.id`. */
  readonly id: string;
  /** When the run was claimed (the database's clock). */
  readonly startedAt: Date;
  /** No outcome stamped yet: the child runs, or is being spawned. */
  readonly open: boolean;
  /** Null while open; `-1` for a hard kill (no exit marker). */
  readonly exitCode: number | null;
  /** What the child's body threw, when it recorded it before exiting. */
  readonly errorMessage: string | null;
}

/**
 * Record, from the CHILD, why its `run` body threw — before it exits 1.
 *
 * `retryable` is the one bit the parent's failure policy cannot recover from an
 * exit code: whether the body declared the failure deterministic.
 */
export async function recordRunError(
  runId: string,
  err: unknown,
  conn: NodePgDatabase = db,
): Promise<void> {
  await conn
    .update(_supervisedJobRuns)
    .set({
      errorMessage: err instanceof Error ? err.message : String(err),
      retryable: !isNonRetryableError(err),
    })
    .where(eq(_supervisedJobRuns.id, runId));
}

/** What the failure policy reads back off a failed run's row. */
export interface RecordedFailure {
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
  /** `cancelSupervisedJobByLock` stamped the run before it ended. */
  readonly cancelled: boolean;
}

export async function readRecordedFailure(
  runId: string,
  conn: NodePgDatabase = db,
): Promise<RecordedFailure> {
  const [row] = await conn
    .select({
      errorMessage: _supervisedJobRuns.errorMessage,
      retryable: _supervisedJobRuns.retryable,
      cancelledAt: _supervisedJobRuns.cancelledAt,
    })
    .from(_supervisedJobRuns)
    .where(eq(_supervisedJobRuns.id, runId));
  if (row === undefined) {
    // The claim inserted this row and only the 30-day retention deletes, so a
    // missing row for a run that just ended is a real fault.
    throw new Error(
      `[supervised-job] run ${runId} ended but has no supervised_job_runs row.`,
    );
  }
  return {
    errorMessage: row.errorMessage,
    retryable: row.retryable,
    cancelled: row.cancelledAt !== null,
  };
}

/**
 * The built-in ledger's failure policy — the dead-letter is its failure
 * surface, since a job without its own ledger has no UI.
 *
 * - exit 0 → `done`.
 * - failed, but the run was cancelled (`cancelSupervisedJobByLock`) → `done`:
 *   the user asked for it to stop, so there is nothing to retry and nothing to
 *   alert on.
 * - failed, and (not retryable, or the last attempt) → throw
 *   `NonRetryableError` naming the job, the run, how it ended, and the child's
 *   recorded error (or that it recorded none).
 * - failed otherwise → `retry`.
 *
 * Pure over what it is handed, so it is deterministic on replay: `onEnded` is
 * not memoized and re-runs for every earlier attempt, and an earlier attempt
 * that answered `retry` the first time answers `retry` again (its row and its
 * attempt number have not changed).
 */
export function applyFailurePolicy(args: {
  jobName: string;
  runId: string;
  terminal: RunTerminal;
  attempt: number;
  runAttempts: number;
  failure: RecordedFailure | null;
}): "done" | "retry" {
  const { terminal } = args;
  if (terminal.exitCode === 0) return "done";
  if (args.failure === null) {
    throw new Error(
      `[supervised-job] ${args.jobName}: a failed run's policy needs its recorded failure.`,
    );
  }
  if (args.failure.cancelled) return "done";
  const last = args.attempt >= args.runAttempts;
  if (args.failure.retryable !== false && !last) return "retry";
  const ended =
    terminal.signalCode !== null
      ? `was killed by ${terminal.signalCode} (exit ${terminal.exitCode})`
      : `exited ${terminal.exitCode}`;
  const why =
    args.failure.errorMessage ??
    (terminal.exitCode === SUPERVISED_EXIT_TEMPFAIL
      ? "the database refused its connection because it was full (EX_TEMPFAIL) — a temporary failure, see the transcript"
      : "killed or crashed before recording an error — see the transcript");
  throw new NonRetryableError(
    `[supervised-job] ${args.jobName}: run ${args.runId} ${ended} on attempt ` +
      `${args.attempt}/${args.runAttempts}` +
      `${args.failure.retryable === false ? " (not retryable)" : ""}: ${why}`,
  );
}
