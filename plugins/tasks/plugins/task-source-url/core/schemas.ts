import { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { liveValue } from "@plugins/network/plugins/live/core";

// The page a task was filed from, stored in the `tasks_ext_source_url`
// entity-extension table (1:1 per task). Written once, when the draft form's
// the Page URL toggle is on; never edited, and never inherited by subtasks.
export const taskSourceUrlShape = defineExtensionShape({
  key: "taskId",
  fields: { url: textField() },
});

const AttemptSourceUrlSchema = z.object({ url: z.string().nullable() });
export type AttemptSourceUrl = z.infer<typeof AttemptSourceUrlSchema>;

// Keyed by attempt: an attempt id is its worktree, which is what a caller
// opening the app holds. The stored URL wins; without one, the url of the
// first `<ui-context>` in the task's prompt. `url: null` = neither exists.
// A live value rather than a one-shot request: a read made while the server
// restarts recovers with the socket instead of failing for good.
export const attemptSourceUrl = liveValue("task-source-url.by-attempt", {
  schema: AttemptSourceUrlSchema,
  params: ["attemptId"],
});
