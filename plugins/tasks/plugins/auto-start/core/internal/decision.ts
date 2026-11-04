import type { TaskStatus } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * What auto-start does with an armed task, read off its status alone:
 *
 * - `launch` — start an agent now;
 * - `wait`   — keep the marker; a later status change looks again;
 * - `disarm` — never start one by itself: the marker is spent, delete it.
 */
export type AutoStartDecision = "launch" | "wait" | "disarm";

/**
 * THE auto-start policy: one explicit decision per task status. Every gate
 * (the queue's launch job, the launch transaction, the launchable-armed read)
 * and every marker cleanup (on a status change, at boot) reads it, and none
 * re-derives launchability from raw columns — the 2026-11-04 incident was such
 * a re-derivation (dropped / held / blocked / an open attempt) that had no
 * clause for `done`, so five tasks that had landed in June launched again.
 *
 * `satisfies Record<TaskStatus, …>` is the enforcement: a status added to
 * `TaskStatusSchema` does not compile until someone decides it here.
 *
 * `blocked` is a derived arm that outranks `attempted` / `new`, so "no
 * blocking prerequisite" is part of the status — no separate check.
 */
export const AUTO_START_DECISIONS = {
  new: "launch",
  // Every past run closed without landing: an arm asks for another run.
  attempted: "launch",
  // Launches once its prerequisites settle.
  blocked: "wait",
  // A person's "not now", not "never": launches when unheld.
  held: "wait",
  // An agent is running on it (started by hand, or raced in): that run IS the
  // launch the marker asked for.
  in_progress: "disarm",
  need_action: "disarm",
  in_progress_blocked: "disarm",
  // Landed. Another run is a person's explicit Launch, never the queue's.
  done: "disarm",
  // Abandoned.
  dropped: "disarm",
} as const satisfies Record<TaskStatus, AutoStartDecision>;

export function autoStartDecision(status: TaskStatus): AutoStartDecision {
  return AUTO_START_DECISIONS[status];
}

/** The statuses that decide `decision`, for a SQL `IN` over `tasks_v.status`. */
export function statusesDeciding(decision: AutoStartDecision): TaskStatus[] {
  return (Object.keys(AUTO_START_DECISIONS) as TaskStatus[]).filter(
    (s) => AUTO_START_DECISIONS[s] === decision,
  );
}
