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
 * What an `after` / `manual` task filed with no `after` runs after:
 *
 * - `caller` — the caller's own task: the new task follows its work, and
 *   launches once that task is done.
 * - `none` — nothing. For a caller whose task stays in progress while the
 *   tasks it files run — a supervisor's root — a task waiting on it could
 *   never launch during the session.
 */
export const DEFAULT_AFTERS = ["caller", "none"] as const;
export const DefaultAfterSchema = z.enum(DEFAULT_AFTERS);
export type DefaultAfter = z.infer<typeof DefaultAfterSchema>;

/**
 * The `tasks.file` grant: per track, how the agent may file tasks into its
 * subtree. A track absent from the grant is refused. The track keys are the
 * task tracks (`tasks/task-track`'s `TASK_TRACKS`, which this leaf cannot
 * import: task-track imports tasks-core) — `tasks`' describe pins them equal
 * at compile time. `defaultAfter` (absent = `caller`) is what a task filed
 * with no `after` waits on. `backlog` (absent = no) lets the agent file into
 * a supervisor role's backlog instead of its own subtree (`add_task`'s
 * `supervisor`): the task waits there, unlaunched, until a session of that
 * role adopts it — whatever the track grants say.
 */
export const TasksFileGrantSchema = z
  .object({
    main: TrackFilingGrantSchema.optional(),
    sidequest: TrackFilingGrantSchema.optional(),
    defaultAfter: DefaultAfterSchema.optional(),
    backlog: z.literal(true).optional(),
  })
  .strict();
export type TasksFileGrant = z.infer<typeof TasksFileGrantSchema>;

/** May file tasks into its subtree (`add_task`). */
export const tasksFile = defineCapability<TasksFileGrant>({
  id: "tasks.file",
  schema: TasksFileGrantSchema,
  label: "File tasks",
});
