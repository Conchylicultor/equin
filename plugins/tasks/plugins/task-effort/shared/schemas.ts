import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { parsedTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { StoredEffortSchema } from "@plugins/conversations/plugins/effort-provider/core";

// One task's thinking mode, stored in the `tasks_ext_effort` entity-extension
// table (1:1 per task), which `server/internal/tables.ts` builds from this
// shape. The stored schema is the tolerant one, so a level id that has since
// been renamed normalizes on read rather than reaching the registry lookup.
// `default` is only the wire default the field record requires — the column
// has no DB default, and an absent row means "no mode".
export const taskEffortShape = defineExtensionShape({
  key: "taskId",
  fields: {
    level: parsedTextField(StoredEffortSchema, { default: "high" }),
  },
  wireTimestamps: ["updatedAt"],
});
export const TaskEffortSchema = taskEffortShape.schema;
export type TaskEffort = z.infer<typeof TaskEffortSchema>;

// One task's mode, read by the task's id. The mode is 1:1 with its task — the
// side-table's primary key IS the task (`taskId`, stored as `parent_id`) — so
// it is a lookup-only collection: no default window (nothing lists every
// task's mode), minting `task-efforts:rows` alone. A reader asks with
// `useLiveRow(taskEfforts, taskId)`, and `found: false` is "no mode set".
//
// Every consumer asks about ONE task and needs an exact answer — the launch
// option's picker both reads and writes this row — so a point read is the
// right bound rather than a window, which could silently render a set mode as
// "none". The `:rows` point routing sends a write to a tuple iff the changed
// ids intersect its set, so setting one task's mode never sweeps the table.
//
// NOT preloaded (a lookup-only collection cannot be): it hydrates post-mount
// via its sub-ack. Served from the extension handle in
// `server/internal/resource.ts`.
export const taskEfforts = liveCollection("task-efforts", {
  from: taskEffortShape,
  id: "taskId",
});
