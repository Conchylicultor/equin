import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import type { ColumnOverride } from "@plugins/network/plugins/live/server";
import { _attempts, _conversations, _tasks } from "./tables";

/**
 * A conversation's attempt, as a query-resource lookup join over
 * `_conversations` — the first of {@link conversationOwnerJoins}, alone for a
 * collection that reads the attempt and not its task
 * (`conversationWorkspaces`). REQUIRED (INNER): `conversations.attempt_id`
 * is a NOT NULL cascade FK, so it drops no conversation. Its route is a
 * REVERSE route on `attempts.id`, gated on the attempt columns the
 * collection reads.
 */
export const conversationAttemptJoin = {
  kind: "lookup",
  alias: "attempt",
  table: _attempts,
  pk: _attempts.id,
  on: { from: "base", col: _conversations.attemptId },
  required: true,
} as const satisfies LookupJoin<"attempt", typeof _attempts>;

/**
 * A conversation's owners, as query-resource joins over `_conversations`: its
 * attempt (`base.attemptId`), then that attempt's task (`attempt.taskId`).
 *
 * Both REQUIRED (INNER): `conversations.attempt_id` and `attempts.task_id` are
 * NOT NULL cascade FKs, so the joins drop no conversation — the same rows
 * `conversations_v` lists, read from the base tables (a routed compile never
 * reads a view). Each lookup's route is a REVERSE route on its pk:
 *
 * - an `attempts` write resolves to the conversations naming the attempt (a
 *   probe over `conversations.attempt_id` only), gated on the attempt columns
 *   read here (`id`, `task_id`, `worktree_path`);
 * - a `tasks` write resolves through the attempts that name the task (a probe
 *   joining `attempts`, never the changed `tasks` — A10), gated on `id` and
 *   `title`.
 *
 * Shared by every conversation collection (the All-conversations and History
 * lists; the P8 tree reuses them), so the owner shape is spelled once.
 */
export const conversationOwnerJoins = [
  conversationAttemptJoin,
  {
    kind: "lookup",
    alias: "task",
    table: _tasks,
    pk: _tasks.id,
    on: { from: "attempt", col: _attempts.taskId },
    required: true,
  } satisfies LookupJoin<"task", typeof _tasks>,
] as const;

type OwnerJoins = typeof conversationOwnerJoins;

/**
 * The owner columns a conversation row carries, bound over
 * {@link conversationOwnerJoins}: the attempt's checkout and task, and the
 * task's CURRENT title (a rename reaches every list holding the task's
 * conversations through the `tasks` reverse route).
 */
export const conversationOwnerColumns = {
  worktreePath: (j) => j.attempt.worktreePath,
  taskId: (j) => j.attempt.taskId,
  taskTitle: (j) => j.task.title,
} satisfies Record<
  "worktreePath" | "taskId" | "taskTitle",
  ColumnOverride<typeof _conversations, OwnerJoins>
>;
