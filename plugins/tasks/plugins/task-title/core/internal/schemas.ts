import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// One task's short title (at most three words), stored in the
// `tasks_ext_short_title` entity-extension table (1:1 per task), which
// `server/internal/short-title-tables.ts` builds from this shape.
//
// `sourceTitle` is the full title the short one was made from. A reader shows
// `shortTitle` only while `sourceTitle` still equals the task's current title:
// a rename makes the row stale at once, with no window where the old short
// title stands for the new full one. The `task-title.short` job rewrites it.
export const taskShortTitleShape = defineExtensionShape({
  key: "taskId",
  fields: {
    shortTitle: textField(),
    sourceTitle: textField(),
  },
  wireTimestamps: ["updatedAt"],
});
export const TaskShortTitleSchema = taskShortTitleShape.schema;
export type TaskShortTitle = z.infer<typeof TaskShortTitleSchema>;

// One task's short title, read by the task's id: a lookup-only collection
// (nothing lists every task's short title), minting `task-short-titles:rows`
// alone. `found: false` means none has been generated (yet, or ever: the
// backfill only covers tasks with a recent conversation).
export const taskShortTitles = liveCollection("task-short-titles", {
  from: taskShortTitleShape,
  id: "taskId",
});
