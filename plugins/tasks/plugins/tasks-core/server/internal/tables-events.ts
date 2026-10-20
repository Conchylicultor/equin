import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
import type { TaskStatus } from "./schema";
import type { ConversationStatus } from "../../core/conversation-status";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";

export interface PushLandedPayload {
  pushId: string;
  sha: string;
  attemptId: string;
  conversationId: string;
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

export interface ConversationStatusChangedPayload {
  conversationId: string;
  taskId: string | null;
  status: ConversationStatus;
  previousStatus: ConversationStatus;
  [key: string]: unknown;
}

// Emitted at the conversation status-write chokepoint whenever a single
// conversation's `status` column actually changes (working↔waiting, →gone,
// →done, insert). Finer-grained than `tasks.statusChanged`, which only fires
// when the parent task's *derived* status flips. No filter columns: the sole
// consumer (the conversations turn-emitter reconcile) re-reads the row and is
// idempotent.
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
