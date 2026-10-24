import type { TaskTriageRow } from "./resources";
import type { TriageResult } from "./result";
import type { TriageStaleReason, TriageState } from "./vocabulary";

/** What every triage row carries, whatever its state. */
interface TriageReadBase {
  taskId: string;
  /** The latest run's conversation (null until its launch landed). */
  conversationId: string | null;
  /** The run's own task (null until its first launch). */
  runTaskId: string | null;
  requestedAt: Date;
}

/** A read that landed: the result, the person's answer, and when. */
export interface TriageReadResult extends TriageResult {
  triagedAt: Date;
  /** The main commit the read saw the code at. */
  mainSha: string;
  /** The person's one-click answer to `question` (one of `answers`). */
  answer: string | null;
}

/**
 * A triage row, parsed into the state it is in — so a consumer reaches a
 * result only where there is one:
 *
 * - `queued` / `running` — a run is in flight; `previous` is the read it will
 *   replace (shown greyed), or null for a first run.
 * - `failed` — the latest run ended without a read (`error`); `previous` as
 *   above.
 * - `done` — the read describes the task.
 * - `stale` — the read is `old` or the task was `edited` since.
 */
export type TriageRead =
  | (TriageReadBase & {
      state: "queued" | "running";
      startedAt: Date | null;
      previous: TriageReadResult | null;
    })
  | (TriageReadBase & {
      state: "failed";
      error: string;
      previous: TriageReadResult | null;
    })
  | (TriageReadBase & { state: "done"; read: TriageReadResult })
  | (TriageReadBase & {
      state: "stale";
      staleReason: TriageStaleReason;
      read: TriageReadResult;
    });

/** A row that breaks the state ⇄ fields contract — a bug in whoever wrote it. */
export class TriageRowError extends Error {
  constructor(taskId: string, state: TriageState, problem: string) {
    super(`[task-triage] row of ${taskId} is ${state} but ${problem}`);
    this.name = "TriageRowError";
  }
}

/** The row's result, or null when it holds none (no read landed yet). */
function resultOf(row: TaskTriageRow): TriageReadResult | null {
  const { verdict, priority, taskType, risk, context, triagedAt, mainSha } =
    row;
  if (
    verdict === null ||
    priority === null ||
    taskType === null ||
    risk === null ||
    context === null ||
    triagedAt === null ||
    mainSha === null
  ) {
    const fields = {
      verdict,
      priority,
      taskType,
      risk,
      context,
      triagedAt,
      mainSha,
    };
    const missing = Object.entries(fields)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    if (missing.length === Object.keys(fields).length) return null;
    throw new TriageRowError(
      row.taskId,
      row.state,
      `its result is partial (missing ${missing.join(", ")})`,
    );
  }
  return {
    verdict,
    priority,
    taskType,
    risk,
    context,
    question: row.question,
    answers: row.answers,
    areas: row.areas,
    triagedAt,
    mainSha,
    answer: row.answer,
  };
}

/**
 * Parse a `tasks_ext_triage` row into its {@link TriageRead}. Throws
 * {@link TriageRowError} on a row that breaks the contract: a `done` / `stale`
 * row without a full result, a `stale` one without its reason, a `failed` one
 * without its error, a partial result in any state.
 */
export function parseTriageRead(row: TaskTriageRow): TriageRead {
  const base: TriageReadBase = {
    taskId: row.taskId,
    conversationId: row.conversationId,
    runTaskId: row.runTaskId,
    requestedAt: row.requestedAt,
  };
  const result = resultOf(row);
  switch (row.state) {
    case "queued":
    case "running":
      return {
        ...base,
        state: row.state,
        startedAt: row.startedAt,
        previous: result,
      };
    case "failed":
      if (row.error === null) {
        throw new TriageRowError(row.taskId, row.state, "it has no error");
      }
      return { ...base, state: "failed", error: row.error, previous: result };
    case "done":
      if (result === null) {
        throw new TriageRowError(row.taskId, row.state, "it has no result");
      }
      return { ...base, state: "done", read: result };
    case "stale":
      if (result === null) {
        throw new TriageRowError(row.taskId, row.state, "it has no result");
      }
      if (row.staleReason === null) {
        throw new TriageRowError(row.taskId, row.state, "it has no reason");
      }
      return {
        ...base,
        state: "stale",
        staleReason: row.staleReason,
        read: result,
      };
  }
}

/**
 * The read a ranking may use: a `done` or `stale` read's — `null` for a task
 * not triaged, or whose only run is in flight or failed with nothing before it.
 * A run in flight or failed keeps ranking by the read it would replace.
 */
export function latestTriageResult(
  read: TriageRead | null,
): TriageReadResult | null {
  if (read === null) return null;
  switch (read.state) {
    case "done":
    case "stale":
      return read.read;
    case "queued":
    case "running":
    case "failed":
      return read.previous;
  }
}
