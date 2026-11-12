import { z } from "zod";

// The Task* built-ins' inputs, as their cards and the task-list fold read
// them. A task is named `taskId` (an older harness wrote `id`), so both are
// optional and read as `taskId ?? id`.

/** TaskCreate's input. */
export const TaskCreateInputSchema = z.looseObject({
  subject: z.string().optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

/** TaskUpdate's input. */
export const TaskUpdateInputSchema = z.looseObject({
  taskId: z.string().optional(),
  id: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
});
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

/** TaskGet's, TaskOutput's and TaskStop's input: the task it names. */
export const TaskRefInputSchema = z.looseObject({
  taskId: z.string().optional(),
  id: z.string().optional(),
});
export type TaskRefInput = z.infer<typeof TaskRefInputSchema>;

/** TaskList's input: its card reads none of it. */
export const TaskListInputSchema = z.looseObject({});
export type TaskListInput = z.infer<typeof TaskListInputSchema>;
