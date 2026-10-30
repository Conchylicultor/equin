import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
import type { TaskStatus } from "./schema";
import type { ConversationStatus } from "../../core/conversation-status";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";

export interface PushLandedPayload {
  pushId: string;
  sha: string;
  attemptId: string;
  /** Null when the push named only its attempt (a session equin did not launch). */
  conversationId: string | null;
  [key: string]: unknown;
}

// No filter columns: all subscribers match every emit. Add filter slots here
// (e.g. attemptId, conversationId) if future consumers need scoped delivery.
export const { event: pushLanded, table: _pushLandedTriggers } =
  defineTriggerEvent<PushLandedPayload>({
    name: "pushes.landed",
    filters: {},
  });

export interface TaskStatusChangedPayload {
  taskId: string;
  folderId: string | null;
  status: TaskStatus;
  previousStatus: TaskStatus;
  [key: string]: unknown;
}

// Emitted when a task's computed status flips. Subscribers can scope by
// `taskId` and/or `status` (the helper `or(isNull, eq)` matches a column
// left null on the trigger row, so subscribing to a specific task without
// a status filter matches every transition for that task).
export const { event: taskStatusChanged, table: _taskStatusChangedTriggers } =
  defineTriggerEvent<TaskStatusChangedPayload>({
    name: "tasks.statusChanged",
    filters: {
      taskId: text("task_id"),
      status: text("status"),
    },
  });

export interface TaskCreatedPayload {
  taskId: string;
  folderId: string | null;
  title: string;
  /** Who filed it: a conversation id when an agent did, else a person. */
  author: string | null;
  [key: string]: unknown;
}

// Emitted once per task, by `createTaskOn`, on the creating executor (it
// commits or rolls back with the row). Filterable by folderId.
export const { event: taskCreated, table: _taskCreatedTriggers } =
  defineTriggerEvent<TaskCreatedPayload>({
    name: "tasks.created",
    filters: {
      folderId: text("folder_id"),
    },
  });

export interface TaskTitleChangedPayload {
  taskId: string;
  title: string;
  [key: string]: unknown;
}

// Emitted at each of the task title write points (`createTaskOn`, `updateTaskOn`
// with a title in the patch, and `updateTaskTitle` when its CAS write landed).
// The payload's `title` is what was written; a subscriber doing slow work on it
// re-reads the task before persisting anything derived, since a newer write may
// have landed in between (its own event is then on its way).
export const { event: taskTitleChanged, table: _taskTitleChangedTriggers } =
  defineTriggerEvent<TaskTitleChangedPayload>({
    name: "tasks.titleChanged",
    filters: {
      taskId: text("task_id"),
    },
  });

export interface TaskDescriptionChangedPayload {
  taskId: string;
  description: string | null;
  [key: string]: unknown;
}

// Emitted when `updateTaskOn` writes a description (`patch.description` set,
// `null` included). Not on creation: a new task's text is announced by
// `tasks.titleChanged`. Like that event, a subscriber doing slow work re-reads
// the task before persisting anything derived. Filterable by taskId.
export const {
  event: taskDescriptionChanged,
  table: _taskDescriptionChangedTriggers,
} = defineTriggerEvent<TaskDescriptionChangedPayload>({
  name: "tasks.descriptionChanged",
  filters: {
    taskId: text("task_id"),
  },
});

export interface ConversationStatusChangedPayload {
  conversationId: string;
  taskId: string | null;
  status: ConversationStatus;
  previousStatus: ConversationStatus;
  /** What the agent waits on (`"question"`: the user's answer), after and
   * before the write — the refinement of `waiting` the event also fires on. */
  waitingFor: string | null;
  previousWaitingFor: string | null;
  [key: string]: unknown;
}

// Emitted at the conversation status-write chokepoint whenever a single
// conversation's `status` column actually changes (working↔waiting, →gone,
// →done, insert) — OR its `waitingFor` does, the status unchanged (a question
// answered or withdrawn while the agent stays `waiting`): what the agent waits
// on is part of its status for whoever holds work until it can take a turn
// (watch delivery, self-compact). So `status === previousStatus` is a real
// payload; a subscriber that cares about the status alone compares the two.
// Finer-grained than `tasks.statusChanged`, which only fires when the parent
// task's *derived* status flips. No filter columns: subscribers re-read the
// row and are idempotent.
export const {
  event: conversationStatusChanged,
  table: _conversationStatusChangedTriggers,
} = defineTriggerEvent<ConversationStatusChangedPayload>({
  name: "conversation.statusChanged",
  filters: {},
});

// Emitted once per conversation, when its row is created (a launch, or the
// status reconciler adopting one).
export interface ConversationCreatedPayload {
  conversationId: string;
  taskId: string;
  model: ConversationModel;
  spawnedBy: string;
  // The launcher shows the conversation itself — the user is looking at it.
  shownByLauncher?: boolean;
  createdAt: string;
  prompt?: string;
  kind?: string;
  prepromptId?: string;
  [key: string]: unknown;
}

export const {
  event: conversationCreated,
  table: _conversationCreatedTriggers,
} = defineTriggerEvent<ConversationCreatedPayload>({
  name: "conversation.created",
  filters: {
    conversationId: text("conversation_id"),
  },
});
