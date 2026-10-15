import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// One task's selected preprompt, stored in the `tasks_ext_preprompt`
// entity-extension table (1:1 per task), which `server/internal/tables.ts`
// builds from this shape.
export const taskPrepromptShape = defineExtensionShape({
  key: "taskId",
  fields: { prepromptId: textField() },
  wireTimestamps: ["updatedAt"],
});
export const TaskPrepromptSchema = taskPrepromptShape.schema;
export type TaskPreprompt = z.infer<typeof TaskPrepromptSchema>;

// One task's selection, read by the task's id. The selection is 1:1 with its
// task — the side-table's primary key IS the task (`taskId`, stored as
// `parent_id`) — so it is a lookup-only collection: no default window (nothing
// lists every task's selection), minting `task-preprompts:rows` alone. A reader
// asks with `useLiveRow(taskPreprompts, taskId)`, and `found: false` is "none
// selected".
//
// Every consumer asks about ONE task and needs an exact answer — the launch
// option's picker both reads and writes this row — so a point read is the
// right bound rather than a window, which could silently render a selected
// preprompt as "None". The `:rows` point routing sends a write to a tuple iff
// the changed ids intersect its set, so selecting one task's preprompt never
// sweeps the table.
//
// NOT preloaded (a lookup-only collection cannot be): it hydrates post-mount
// via its sub-ack. Served from the extension handle in
// `server/internal/resource.ts`.
export const taskPreprompts = liveCollection("task-preprompts", {
  from: taskPrepromptShape,
  id: "taskId",
});
