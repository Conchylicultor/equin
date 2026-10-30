import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { todoTaskShape } from "../../shared/schemas";

// `page_blocks_ext_todo_task(parent_id PK → page_blocks, task_id → tasks)`: the
// task a TODO card dispatched an agent onto. Presence = this card has been
// dispatched at least once.
//
// ## An extension on the BLOCK, so "one task per card" is a fact of the schema
//
// `defineExtension` synthesizes the key (`blockId`, stored as `parent_id`) as
// the PRIMARY KEY, which is exactly the constraint this record needs: a card can
// hold at most one task, and the database is what says so. The alternative —
// copying `page/prompt/link`'s `tasks_ext_prompt_block`, a 1:N extension on the
// TASK side — would leave "one task per card" as a rule the create endpoint
// remembers to check, i.e. a rule two concurrent dispatches can both pass. Here
// the second one is an upsert onto the same key.
//
// The 1:N shape is right for `/prompt` and wrong here because the two blocks
// mean different things: a prompt block is a re-runnable instruction (each run
// is its own piece of work), while a TODO card is ONE piece of work that may
// take several attempts. Attempts already exist as a concept — `createConversation`
// with a `taskId` and no `attemptId` mints one — so the card needs no second
// axis of its own.
//
// ## Both FKs CASCADE, which is the opposite of what its two neighbours do
//
// `agent-notes/authorship` keeps a dangling `conversation_id`, and
// `page/prompt/link` keeps a dangling `block_id`, both for the same reason: those
// rows are STATEMENTS that stay true after one end dies ("an agent wrote this
// card"; "this task came from a page"). This row is not a statement, it is a
// LINK — it means nothing once either end is gone:
//
//  - card deleted ⇒ there is nothing left to dispatch from, and nothing that
//    could ever read the row again;
//  - task deleted ⇒ the card is free for a fresh dispatch, which is also the
//    only "detach" affordance this feature has. Keeping the row would leave the
//    card permanently bound to a task that no longer exists.
//
// ## Growth bound
//
// The `parent_id` CASCADE is the reclaim: rows die with the card. Asserted at
// boot by `markCascadeBounded` (see ./growth-bound.ts) rather than trusted. Note
// `page_blocks` SOFT-deletes (trash), so that cascade fires at purge, not at the
// user's delete — a restored card keeps its task.
//
// ## The `task_id` index
//
// The PK's implicit btree covers `WHERE parent_id = ?` (the resource's only
// read) and nothing else. The index on `task_id` is for the FK itself: without
// one, deleting a task makes Postgres seq-scan this table to find the rows its
// CASCADE must reclaim.
export const todoTask = defineExtension(_blocks, "todo_task", todoTaskShape, {
  columns: {
    taskId: { references: { column: () => _tasks.id, onDelete: "cascade" } },
  },
  indexes: (t, b) => [b.index("task").on(t.taskId)],
});
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _pageBlocksTodoTaskExt = todoTask.table;
