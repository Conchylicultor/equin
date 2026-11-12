import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  TaskCreateInputSchema,
  TaskRefInputSchema,
  TaskUpdateInputSchema,
} from "./inputs";

export interface TaskEntry {
  taskId: string;
  description: string;
  status: string;
}

export interface TaskAggregate {
  tasks: TaskEntry[];
  completedCount: number;
  totalCount: number;
  shouldShow: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/** The id a TaskCreate result names, under whichever key the harness used. */
const CreatedTaskSchema = z.looseObject({
  id: z.string().optional(),
  task_id: z.string().optional(),
  taskId: z.string().optional(),
});

function createdTaskId(event: ToolCallEvent): string | undefined {
  if (!event.result?.content || event.result.isError) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(event.result.content);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return undefined;
  }
  const read = CreatedTaskSchema.safeParse(json);
  if (!read.success) return undefined;
  return read.data.id ?? read.data.task_id ?? read.data.taskId;
}

/**
 * The agent's Task* tool calls folded into its task list. A call whose input
 * is not what its tool takes (the model got it wrong; the tool refused it)
 * changes nothing.
 */
export function buildAggregate(events: readonly JsonlEvent[]): TaskAggregate {
  const taskMap = new Map<string, TaskEntry>();
  const ordered: string[] = [];

  for (const ev of events) {
    if (ev.kind !== "tool-call") continue;
    const toolEvent: ToolCallEvent = ev;

    if (toolEvent.name === "TaskCreate" && toolEvent.result) {
      const read = TaskCreateInputSchema.safeParse(toolEvent.input);
      if (!read.success) continue;
      const input = read.data;
      const taskId = createdTaskId(toolEvent);
      if (!taskId) continue;
      if (!taskMap.has(taskId)) {
        ordered.push(taskId);
      }
      taskMap.set(taskId, {
        taskId,
        description: input.subject ?? input.description ?? "Task",
        status: "pending",
      });
    } else if (
      toolEvent.name === "TaskUpdate" &&
      toolEvent.result &&
      !toolEvent.result.isError
    ) {
      const read = TaskUpdateInputSchema.safeParse(toolEvent.input);
      if (!read.success) continue;
      const input = read.data;
      const taskId = input.taskId ?? input.id;
      if (!taskId) continue;
      const existing = taskMap.get(taskId);
      if (existing) {
        if (input.status) existing.status = input.status;
        if (input.description) existing.description = input.description;
      }
    } else if (toolEvent.name === "TaskStop" && toolEvent.result) {
      const read = TaskRefInputSchema.safeParse(toolEvent.input);
      if (!read.success) continue;
      const taskId = read.data.taskId ?? read.data.id;
      if (!taskId) continue;
      const existing = taskMap.get(taskId);
      if (existing) existing.status = "stopped";
    }
  }

  const tasks = ordered.map((id) => taskMap.get(id)!).filter(Boolean);
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const allTerminal =
    tasks.length > 0 && tasks.every((t) => TERMINAL_STATUSES.has(t.status));

  return {
    tasks,
    completedCount,
    totalCount: tasks.length,
    shouldShow: tasks.length > 0 && !allTerminal,
  };
}

const TaskAggregateSchema = z.object({
  tasks: wholeList(
    z.object({
      taskId: z.string(),
      description: z.string(),
      status: z.string(),
    }),
    {
      reason:
        "one conversation's own task list (TaskCreate calls): a checklist the pane shows entire",
    },
  ),
  completedCount: z.number().int(),
  totalCount: z.number().int(),
  shouldShow: z.boolean(),
});

/**
 * A conversation's task list over its WHOLE transcript — its pane holds only
 * the latest events, and a task may have been created long before them.
 */
export const conversationTaskAggregate = liveValue(
  "jsonl-viewer.task-tools.aggregate",
  { schema: TaskAggregateSchema, params: ["id"] },
);
