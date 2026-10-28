import { watchSource } from "@plugins/tasks/plugins/orchestration/plugins/watch/machine";
import {
  conversationCreated,
  taskCreated,
  taskStatusChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import { isSettled } from "@plugins/tasks/plugins/tasks-core/core";
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

/** A task settled — done or dropped (`settled`). */
const settledSource = watchSource({
  id: "tasks.settled",
  on: taskStatusChanged,
  toEvents: (p) =>
    isSettled(p.status) && !isSettled(p.previousStatus)
      ? [
          {
            kind: "settled",
            taskId: p.taskId,
            summary: `${p.previousStatus} → ${p.status}`,
          },
        ]
      : [],
});

export const tasksWatchSources = [
  ...createdSource,
  ...startedSource,
  ...settledSource,
];
