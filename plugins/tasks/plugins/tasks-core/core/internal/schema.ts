import { z } from "zod";
import { fieldsToZodObject, type FieldOptionMeta } from "@plugins/fields/core";
import { StoredModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import { RankSchema } from "@plugins/primitives/plugins/rank/core";
import { ConversationStatusSchema } from "../conversation-status";
import {
  taskFields,
  attemptFields,
  pushFields,
  conversationFields,
} from "./fields";

// Public Zod schemas + types for the tasks / attempts / conversations cluster.
//
// The BASE row columns are derived from the per-table field records (the single
// source of truth shared with the physical `defineEntity` tables in
// `server/internal/tables.ts`, so wire ↔ column drift is unrepresentable). On
// top of the base rows, `.extend(...)` layers:
//   - the computed *view* columns the derived pgViews add (`status`, `active`,
//     `finishedAt`, `dependencies`, `worktreePath`, `taskId`); and
//   - the transform overrides (`rank` → the `Rank` value object, `model` → the
//     tolerant `StoredModelSchema`, the enum-branded `status` / `kind`).
//
// These schemas describe the VIEW row shapes the live-state resources publish —
// richer than the base table row — so they intentionally differ from
// `entity.schema`. Lives in `core/` (web-safe) so the browser can evaluate them
// without reaching into the server-only `defineEntity` path.

export const TaskStatusSchema = z.enum([
  "new",
  "in_progress",
  "need_action",
  "attempted",
  "done",
  "held",
  "dropped",
  // The two blocked states — a task with an unresolved prerequisite, split by
  // whether an agent is running on it right now. `blocked` is at rest;
  // `in_progress_blocked` has a live attempt (launched by hand, or the
  // prerequisite edge was added after the launch). Consumers asking "does this
  // task have an unresolved prerequisite?" must use `isBlockedStatus`, never a
  // comparison against one of the two literals.
  "blocked",
  "in_progress_blocked",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * How each task status is named — the `status` field's options in every task
 * list (`taskRows`), and the label every status chip / icon reads
 * (`task-status`'s `STATUS_META`), so the two cannot disagree.
 */
export const TASK_STATUS_OPTIONS = {
  new: { label: "New" },
  in_progress: { label: "In progress" },
  need_action: { label: "Need action" },
  attempted: { label: "Attempted" },
  done: { label: "Done" },
  held: { label: "Held" },
  dropped: { label: "Dropped" },
  blocked: { label: "Blocked" },
  in_progress_blocked: { label: "In progress (blocked)" },
} as const satisfies Record<TaskStatus, FieldOptionMeta>;

// Every value names a fact the attempt's row PROVES (invariant I6, see the
// status CASE in server/internal/views.ts). `pushed` / `completed` are the only
// two that claim anything about work landing, and both require a `pushes` row;
// `dormant` / `closed` report how the SESSION ended and claim nothing either way.
//
// There is deliberately no `abandoned`. It used to be the CASE's `ELSE`, i.e. a
// verdict reached from the ABSENCE of a ledger row — which conflated "never
// pushed", "finished with nothing to push", "landed untrailered" and "the ledger
// has not caught up", and additionally swallowed every hibernated (`gone`)
// attempt. Absence of evidence has no spelling here on purpose: removing the
// value is what makes the claim unwritable rather than merely discouraged.
export const AttemptStatusSchema = z.enum([
  "pending",
  "in_progress",
  "pushed",
  "completed",
  "dormant",
  "closed",
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const ConversationKindSchema = z.enum(["user", "agent", "system"]);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const TaskSchema = fieldsToZodObject(taskFields).extend({
  rank: RankSchema,
  status: TaskStatusSchema,
  active: z.boolean(),
  finishedAt: z.coerce.date().nullable(),
  dependencies: z.array(z.string()),
});
export type Task = z.infer<typeof TaskSchema>;

// List-view projection: the full task minus the heavy `description` text column
// (~60% of the bulk `tasks` live-state payload). The list never renders
// descriptions; the detail pane sources them from the per-id
// `taskDescriptions` collection. Keeping this a distinct type makes any list consumer that reaches
// for `description` fail to compile. See
// research/2026-06-05-tasks-list-detail-payload-split.md.
export const TaskListItemSchema = TaskSchema.omit({ description: true });
export type TaskListItem = z.infer<typeof TaskListItemSchema>;

// `workspace` is left off: the `attempts` row is pinned by the C39 old-bundle
// check (`attemptRows`), so the attempt's workspace crosses the wire on its
// own lookup collection, `attemptWorkspaces`.
export const AttemptSchema = fieldsToZodObject(attemptFields)
  .omit({ workspace: true })
  .extend({
    status: AttemptStatusSchema,
    // PROGRESS vs RETENTION — two deliberately separate notions; see the column
    // comments in server/internal/views.ts before reading either.
    //   active   — an agent is expected to be running (conversation not gone/done).
    //              Display only; NEVER gate a destructive action on it.
    //   retained — the user has not explicitly finished with this attempt
    //              (conversation not done), so its worktree + fork DB are still
    //              theirs. This is the one destructive consumers must read.
    active: z.boolean(),
    retained: z.boolean(),
    finishedAt: z.coerce.date().nullable(),
  });
export type Attempt = z.infer<typeof AttemptSchema>;

export const PushSchema = fieldsToZodObject(pushFields);
export type Push = z.infer<typeof PushSchema>;

export const ConversationSchema = fieldsToZodObject(conversationFields).extend({
  status: ConversationStatusSchema,
  // Tolerant by construction (see StoredModelSchema): a malformed stored
  // model (e.g. written by a concurrent worktree on incompatible code) normalizes
  // to a concrete model instead of rejecting the row; a well-formed id is valid
  // whether or not this machine's catalog knows it — which would blank a whole conversations sub-resource array.
  model: StoredModelSchema,
  kind: ConversationKindSchema,
  worktreePath: z.string(),
  taskId: z.string(),
  // The owning task's current title (joined in `conversations_v`).
  taskTitle: z.string(),
  active: z.boolean(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
