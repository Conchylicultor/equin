import type { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { exposedColumns } from "@plugins/network/plugins/live/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

// One task's short title (at most three words), stored in the
// `tasks_ext_short_title` entity-extension table (1:1 per task), which
// `server/internal/tables.ts` builds from this shape.
//
// `sourceTitle` is the full title the short one was made from. A reader shows
// `shortTitle` only while `sourceTitle` still equals the task's current title:
// a rename makes the row stale at once, with no window where the old short
// title stands for the new full one. The `task-title.short` job rewrites it.
//
// It EXPOSES both fields to every list whose rows reach a task (the
// conversation lists, the task list): the short title rides each row, in the
// same read — and the same boot snapshot — as the row it names, so a list
// never draws a row by its full title and then swaps in the short one when a
// second read lands. A task with no row reads NULL for both (none generated
// yet, or ever: the backfill only covers tasks with a recent conversation).
export const taskShortTitleShape = defineExtensionShape({
  key: "taskId",
  fields: {
    shortTitle: textField({ label: "Short title" }),
    sourceTitle: textField({ label: "Short title source" }),
  },
  wireTimestamps: ["updatedAt"],
  exposes: {
    parent: tasksEntityRef,
    name: "short_title",
    fields: { shortTitle: {}, sourceTitle: {} },
  },
});
export const TaskShortTitleSchema = taskShortTitleShape.schema;
export type TaskShortTitle = z.infer<typeof TaskShortTitleSchema>;

/** The exposed short title, as every row reaching a task carries it (`$columns`). */
export const taskShortTitleColumns = exposedColumns(
  taskShortTitleShape.exposure,
);
