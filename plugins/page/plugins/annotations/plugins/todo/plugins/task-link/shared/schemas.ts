import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// The task ONE TODO card dispatched an agent onto, and when it was first
// dispatched. It carries the link and nothing else — no title, no status: those
// are the TASK's, they change without the link changing, and the client already
// holds them on the boot-critical `tasks` resource. Copying them here would make
// this row a second, drifting answer to a question the task list already
// answers.
//
// The `page_blocks_ext_todo_task` row, keyed on the card's `blockId`;
// `server/internal/tables.ts` builds the table (and the `task_id` FK) from this
// shape.
export const todoTaskShape = defineExtensionShape({
  key: "blockId",
  fields: { taskId: textField() },
  wireTimestamps: ["createdAt"],
});
export const TodoTaskLinkSchema = todoTaskShape.schema;
export type TodoTaskLink = z.infer<typeof TodoTaskLinkSchema>;

// The link of ONE TODO card, read by the card's `blockId`. The table holds 0 or
// 1 row per card — its primary key IS the card (see the table's comment: one
// task per card is a fact of the schema, not a rule the endpoint remembers) —
// so it is a lookup-only collection: no default window (nothing lists every
// card's link), minting `todo-block-task:rows` alone. A card reads its row with
// `useLiveRow(todoTasks, blockId)`, and `found: false` is "not dispatched".
//
// Bounded by construction: only a MOUNTED card subscribes, a load is one
// primary-key seek, and the `:rows` point routing schedules a write for the one
// card whose row it named rather than waking every mounted card.
//
// NOT preloaded (a lookup-only collection cannot be): the card mounts
// route-scoped with its page, so it hydrates post-mount via its sub-ack.
//
// **The row id is `blockId`, the table's primary key** (stored as `parent_id`):
// the point membership intersects the ids a write touched — PK values — with
// each card's id set, so keying on `taskId` would name ids no card subscribed to.
export const todoTasks = liveCollection("todo-block-task", {
  from: todoTaskShape,
  id: "blockId",
});
