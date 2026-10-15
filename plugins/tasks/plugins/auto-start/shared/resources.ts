import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { nullable } from "@plugins/fields/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import {
  DEFAULT_MODEL_CHOICE,
  StoredModelChoiceSchema,
} from "@plugins/conversations/plugins/model-provider/core";

// One task's auto-start marker, stored in the `tasks_ext_auto_start`
// entity-extension table (1:1 per task), which `server/internal/tables.ts`
// builds from this shape.
export const taskAutoStartShape = defineExtensionShape({
  key: "taskId",
  fields: {
    autoStartAt: dateField(),
    // A model CHOICE — a family ("opus", resolved to its newest version when
    // the task launches) or a pinned version. The tolerant schema, not the
    // strict one: model ids get renamed and stored rows outlive them.
    // Normalizing at the COLUMN is what reaches the server-side readers too, and
    // on the wire an unknown stored value normalizes instead of rejecting the
    // row, which would blank the whole resource. `default` is only the wire
    // default the field record requires; the column has no DB default.
    autoStartModel: parsedTextField(StoredModelChoiceSchema, {
      default: DEFAULT_MODEL_CHOICE,
    }),
    // The prompt the launch starts the agent with, when whoever armed it
    // wrote one (an automation's filled template); `null` ⇒ the task's own
    // (`buildTaskPrompt`). On the MARKER, not passed alongside it, so every
    // path that claims the marker — the queue or an inline launch — launches
    // with it. Every arm writes it, so re-arming from the UI clears an
    // automation's prompt rather than inheriting it. Server-only: no reader
    // shows it, and it can be long.
    autoStartPrompt: nullable(textField()),
  },
  serverOnly: ["autoStartPrompt"],
});
export const TaskAutoStartRowSchema = taskAutoStartShape.schema;
export type TaskAutoStartRow = z.infer<typeof TaskAutoStartRowSchema>;

// One task's marker, read by the task's id. The marker is 1:1 with its task —
// the side-table's primary key IS the task (`taskId`, stored as `parent_id`) —
// so it is a lookup-only collection: no default window (nothing lists every
// task's marker), minting `tasks-auto-start:rows` alone. A reader asks with
// `useLiveRow(taskAutoStart, taskId)`, and `found: false` is "not armed".
//
// Every consumer asks about ONE task and needs an exact answer — the launch
// option's select control both reads and writes this row — so a point read is
// the right bound rather than a window, which could silently render an armed
// task as "Off". Subscribers name the task they render: a task row asks for its
// own id, the open task's Prompt card for that task's id. The `:rows` point
// routing sends an arm/disarm to a tuple iff the changed ids intersect its set,
// so arming one task never sweeps the table.
//
// NOT preloaded (a lookup-only collection cannot be): it hydrates post-mount
// via its sub-ack.
//
// **The row id is `taskId`, the table's primary key**: the point membership
// intersects the ids a write touched — PK values — with each reader's id set.
// Served from the extension handle in `server/internal/resource.ts`.
export const taskAutoStart = liveCollection("tasks-auto-start", {
  from: taskAutoStartShape,
  id: "taskId",
});
