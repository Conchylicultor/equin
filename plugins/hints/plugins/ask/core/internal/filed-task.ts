import { z } from "zod";
import { defineThreadResult } from "@plugins/conversations/plugins/agent-thread/core";
import { taskIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { FILE_TASK_TOOL } from "./ids";

/**
 * What the help agent files when the user wants something changed: a task
 * title and its description.
 */
export const AskFiledTaskSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'Short title stating the problem or the wish, in the user\'s terms ("Pages: no serif font option").',
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .describe(
      'What the user wants and why, with what you found (where it lives in the code, what exists today). Describe WHAT is needed, not HOW to build it. End with "Plan first." for anything non-mechanical.',
    ),
});

/** What `ask_file_task` hands back: the task it filed, which the card reads by id. */
const AskFiledTaskOutputSchema = z.object({ taskId: taskIdKind.schema });

/**
 * The result kind of an Ask equin thread: a task it filed (`ask_file_task`).
 * `multiple`: every task one turn files is its own card.
 */
export const askFiledTask = defineThreadResult({
  tool: FILE_TASK_TOOL,
  schema: AskFiledTaskSchema,
  output: AskFiledTaskOutputSchema,
  multiple: true,
});
