import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

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

function parseResultContent(
  event: ToolCallEvent,
): Record<string, unknown> | null {
  if (!event.result?.content || event.result.isError) return null;
  try {
    return JSON.parse(event.result.content);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

/** The agent's Task* tool calls folded into its task list. */
export function buildAggregate(events: readonly JsonlEvent[]): TaskAggregate {
  const taskMap = new Map<string, TaskEntry>();
  const ordered: string[] = [];

  for (const ev of events) {
    if (ev.kind !== "tool-call") continue;
    const toolEvent = ev as ToolCallEvent;

    if (toolEvent.name === "TaskCreate" && toolEvent.result) {
      const result = parseResultContent(toolEvent);
      const input = toolEvent.input as
        { subject?: string; description?: string } | undefined;
      const taskId =
        (result?.id as string) ??
        (result?.task_id as string) ??
        (result?.taskId as string);
      if (!taskId) continue;
      if (!taskMap.has(taskId)) {
        ordered.push(taskId);
      }
      taskMap.set(taskId, {
        taskId,
        description: input?.subject ?? input?.description ?? "Task",
        status: "pending",
      });
    } else if (
      toolEvent.name === "TaskUpdate" &&
      toolEvent.result &&
      !toolEvent.result.isError
    ) {
      const input = toolEvent.input as
        | {
            taskId?: string;
            id?: string;
            status?: string;
            description?: string;
          }
        | undefined;
      const taskId = input?.taskId ?? input?.id;
      if (!taskId) continue;
      const existing = taskMap.get(taskId);
      if (existing) {
        if (input?.status) existing.status = input.status;
        if (input?.description) existing.description = input.description;
      }
    } else if (toolEvent.name === "TaskStop" && toolEvent.result) {
      const input = toolEvent.input as
        { taskId?: string; id?: string } | undefined;
      const taskId = input?.taskId ?? input?.id;
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
  tasks: z.array(
    z.object({
      taskId: z.string(),
      description: z.string(),
      status: z.string(),
    }),
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
