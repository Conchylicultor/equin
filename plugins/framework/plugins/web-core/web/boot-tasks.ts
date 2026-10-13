// The boot-task sequencer: runs a batch of Core.Boot tasks under one deadline
// and publishes each task's status, so App can render what boot is waiting on
// (and how it went wrong) instead of nothing.
//
// A task is never aborted. One past the deadline is marked `overdue` and keeps
// running: when the server answers late (a wedged backend restarted), it flips
// to `done` and boot continues by itself, with no reload.

/** How long a boot task may run before it is shown and reported as overdue. */
export const BOOT_TASK_DEADLINE_MS = 15_000;

export interface BootTask {
  label: string;
  ifUnavailable: "block" | "continue";
  run: () => Promise<void>;
}

export type BootTaskOutcome =
  | { kind: "pending" }
  | { kind: "done" }
  | { kind: "overdue" }
  | { kind: "failed"; message: string };

export interface BootTaskStatus {
  label: string;
  ifUnavailable: "block" | "continue";
  outcome: BootTaskOutcome;
}

/** A failed or overdue task, handed to the caller once per task and outcome. */
export interface BootTaskProblem {
  task: BootTaskStatus;
  elapsedMs: number;
}

export interface BootTaskRun {
  /** Every task's status before any has settled (all `pending`). */
  initial: readonly BootTaskStatus[];
  /** Resolves once boot may proceed (see `isSettled`). Never rejects. */
  settled: Promise<void>;
  /** Proceed now, whatever is still pending, failed or overdue. */
  continueAnyway: () => void;
}

export interface RunBootTasksOptions {
  /** Every status change, as a fresh array. */
  onChange?: (tasks: readonly BootTaskStatus[]) => void;
  onProblem: (problem: BootTaskProblem) => void;
  /**
   * Whether a failed / overdue `block` task holds boot until it settles or the
   * user continues anyway. True for the eager tier (the boot screen is up);
   * false for the deferred tier, which loads behind a painted app and only
   * reports.
   */
  holdOnBlocking: boolean;
  deadlineMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Boot may proceed when no task still has a claim on it: every task is done,
// and anything else is a `continue` task that failed or is overdue (or holding
// is off, so a `block` task in the same state no longer holds either).
function isSettled(tasks: readonly BootTaskStatus[], hold: boolean): boolean {
  return tasks.every((t) => {
    switch (t.outcome.kind) {
      case "done":
        return true;
      case "pending":
        return false;
      case "overdue":
      case "failed":
        return t.ifUnavailable === "continue" || !hold;
    }
  });
}

export function runBootTasks(
  tasks: readonly BootTask[],
  opts: RunBootTasksOptions,
): BootTaskRun {
  const startedAt = performance.now();
  const initial: BootTaskStatus[] = tasks.map((t) => ({
    label: t.label,
    ifUnavailable: t.ifUnavailable,
    outcome: { kind: "pending" },
  }));
  let statuses = initial;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    resolveSettled();
  };

  const update = (i: number, outcome: BootTaskOutcome) => {
    statuses = statuses.map((s, j) => (j === i ? { ...s, outcome } : s));
    if (outcome.kind === "overdue" || outcome.kind === "failed") {
      opts.onProblem({
        task: statuses[i]!,
        elapsedMs: performance.now() - startedAt,
      });
    }
    if (done) return;
    opts.onChange?.(statuses);
    if (isSettled(statuses, opts.holdOnBlocking)) finish();
  };

  if (tasks.length === 0) {
    finish();
    return { initial, settled, continueAnyway: finish };
  }

  timer = setTimeout(() => {
    timer = null;
    statuses.forEach((s, i) => {
      if (s.outcome.kind === "pending") update(i, { kind: "overdue" });
    });
  }, opts.deadlineMs ?? BOOT_TASK_DEADLINE_MS);

  tasks.forEach((t, i) => {
    // A synchronous throw from run() is a failure like any other.
    const run = (async () => await t.run())();
    run.then(
      () => update(i, { kind: "done" }),
      (err: unknown) => {
        console.error(`[boot] Core.Boot task "${t.label}" failed`, err);
        update(i, { kind: "failed", message: errorMessage(err) });
      },
    );
  });

  return { initial, settled, continueAnyway: finish };
}
