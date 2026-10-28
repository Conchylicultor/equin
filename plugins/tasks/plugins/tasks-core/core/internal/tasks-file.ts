import { z } from "zod";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * How a task an agent files starts:
 *
 * - `now` — filed under the caller's task, no dependency, armed.
 * - `after` — runs after the tasks it names (dependencies wired), then armed.
 * - `manual` — dependencies wired the same way, never armed: a person starts it.
 */
export const TASK_FILING_STARTS = ["now", "after", "manual"] as const;
export const TaskFilingStartSchema = z.enum(TASK_FILING_STARTS);
export type TaskFilingStart = z.infer<typeof TaskFilingStartSchema>;

/** What a grant allows on one track: the start modes, and the model a filed
 * task launches with when the caller names none. */
export const TrackFilingGrantSchema = z
  .object({
    start: z.array(TaskFilingStartSchema).min(1),
    model: ModelChoiceSchema.optional(),
  })
  .strict();
export type TrackFilingGrant = z.infer<typeof TrackFilingGrantSchema>;

/**
 * The `tasks.file` grant: per track, how the agent may file tasks into its
 * subtree. A track absent from the grant is refused. The keys are the task
 * tracks (`tasks/task-track`'s `TASK_TRACKS`, which this leaf cannot import:
 * task-track imports tasks-core) — `tasks`' describe pins them equal at
 * compile time.
 */
export const TasksFileGrantSchema = z
  .object({
    main: TrackFilingGrantSchema.optional(),
    sidequest: TrackFilingGrantSchema.optional(),
  })
  .strict();
export type TasksFileGrant = z.infer<typeof TasksFileGrantSchema>;

/** May file tasks into its subtree (`add_task`). */
export const tasksFile = defineCapability<TasksFileGrant>({
  id: "tasks.file",
  schema: TasksFileGrantSchema,
  label: "File tasks",
});
