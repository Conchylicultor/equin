import { desc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { watchSource } from "@plugins/tasks/plugins/orchestration/plugins/watch/machine";
import { spawnFailures } from "@plugins/conversations/plugins/spawn-failure/server";
import { describeSpawnFailure } from "@plugins/conversations/plugins/spawn-failure/core";
import {
  _attempts,
  _conversations,
  conversationCreated,
  taskCreated,
  taskStatusChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  isSettled,
  type TaskStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import type { WatchEventInput } from "@plugins/tasks/plugins/orchestration/plugins/watch/core";
import { conversationIdKind } from "@plugins/tasks/plugins/task-ids/core";

// What a watcher hears about the tasks themselves. Contributed here, not by
// conversations: both facts are task semantics, and the watch plugin imports
// conversations (to type its turn), so conversations cannot feed it.

/** A task was filed in a watched subtree (`created`); the filer, when an
 * agent, is the actor — it does not hear its own filing. */
const createdSource = watchSource({
  id: "tasks.created",
  on: taskCreated,
  toEvents: (p) => [
    {
      kind: "created",
      taskId: p.taskId,
      ...(p.author !== null && conversationIdKind.is(p.author)
        ? { actorConversationId: p.author }
        : {}),
      summary: `filed: ${p.title}`,
    },
  ],
});

/** An agent started on a task (`started`). */
const startedSource = watchSource({
  id: "tasks.started",
  on: conversationCreated,
  toEvents: (p) => [
    {
      kind: "started",
      taskId: p.taskId,
      actorConversationId: p.conversationId,
      summary: `an agent started (${p.conversationId}, ${p.model})`,
      payload: { conversationId: p.conversationId },
    },
  ],
});

/** A task settled — done or dropped (`settled`) — once per settled status it
 * reaches: `dropped → done` is news of its own. A dropped task whose work then
 * landed (`done` outranks `dropped`) used to say nothing, so a watcher kept
 * the `dropped` it had heard and reported shipped work as abandoned
 * (task-1794176984-s6phxk). */
export function settledEvents(p: {
  taskId: string;
  status: TaskStatus;
  previousStatus: TaskStatus;
}): WatchEventInput[] {
  if (!isSettled(p.status) || p.status === p.previousStatus) return [];
  return [
    {
      kind: "settled",
      taskId: p.taskId,
      summary: `${p.previousStatus} → ${p.status}`,
    },
  ];
}

const settledSource = watchSource({
  id: "tasks.settled",
  on: taskStatusChanged,
  toEvents: settledEvents,
});

/** A task stopped short of settling: its agent ended without landing
 * (`stopped`, the task now `attempted`), or a person held it (`held`). Once
 * per transition into either status. `startFailure`: why its latest launch
 * failed to start (the conversation's spawn failure, in words), when it did —
 * an agent that never ran is not one that "ended without landing", and the
 * watcher acts on the difference. */
export function stoppedEvents(
  p: {
    taskId: string;
    status: TaskStatus;
    previousStatus: TaskStatus;
  },
  startFailure: string | null = null,
): WatchEventInput[] {
  if (p.status === p.previousStatus) return [];
  if (p.status === "attempted")
    return [
      {
        kind: "stopped",
        taskId: p.taskId,
        summary:
          startFailure === null
            ? `its agent ended without landing (${p.previousStatus} → attempted)`
            : `agent failed to start: ${startFailure} (${p.previousStatus} → attempted)`,
      },
    ];
  if (p.status === "held")
    return [
      {
        kind: "held",
        taskId: p.taskId,
        summary: `held by a person (${p.previousStatus} → held)`,
      },
    ];
  return [];
}

/**
 * Why the task's latest conversation failed to start, or null when it did
 * not (or the task has none). Its spawn failure is recorded before the
 * conversation turns `gone`, so before the task turns `attempted`.
 */
async function latestStartFailure(taskId: string): Promise<string | null> {
  const [latest] = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(eq(_attempts.taskId, taskId))
    .orderBy(desc(_conversations.createdAt), desc(_conversations.id))
    .limit(1);
  if (latest === undefined) return null;
  const failure = await spawnFailures.get(latest.id);
  return failure === undefined ? null : describeSpawnFailure(failure);
}

const stoppedSource = watchSource({
  id: "tasks.stopped",
  on: taskStatusChanged,
  toEvents: async (p) =>
    stoppedEvents(
      p,
      p.status === "attempted" && p.status !== p.previousStatus
        ? await latestStartFailure(p.taskId)
        : null,
    ),
});

export const tasksWatchSources = [
  ...createdSource,
  ...startedSource,
  ...settledSource,
  ...stoppedSource,
];
