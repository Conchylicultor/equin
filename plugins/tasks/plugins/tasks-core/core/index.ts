export {
  TaskSchema,
  TaskStatusSchema,
  TASK_STATUS_OPTIONS,
  AttemptSchema,
  AttemptStatusSchema,
  PushSchema,
  ConversationSchema,
  ConversationKindSchema,
} from "./internal/schema";
export type {
  Task,
  TaskListItem,
  TaskStatus,
  Attempt,
  AttemptStatus,
  Push,
  Conversation,
  ConversationKind,
} from "./internal/schema";
// The reader half of the commit-trailer grammar. Lives with the `pushes` table
// it fills; `attempt-work` reads it from here. See ./internal/trailers.ts.
export {
  CONVERSATION_TRAILER_KEY,
  PUSH_TRAILER_KEY,
  TRAILER_LOG_FORMAT,
  parseTrailerLog,
} from "./internal/trailers";
export type { TrailerCommit } from "./internal/trailers";

export { ConversationStatusSchema } from "./conversation-status";
export { ADOPTED_SPAWNED_BY, isAdoptedConversation } from "./adopted";
export type { ConversationStatus } from "./conversation-status";
export { ConversationSummarySchema } from "./schemas";
export type { ConversationSummary, AttemptWithConversations } from "./schemas";

// Client/shared live-state declarations (single source of truth for key/schema/
// keyed-ness; the server resources are built from these). See ./resources.ts.
export {
  taskRows,
  type TaskRow,
  taskDescriptions,
  attemptRows,
  attemptWorkspaces,
  pushRows,
  conversationsActive,
  conversationsSystem,
  conversationsGone,
  conversationsById,
  RECENT_GONE_LIMIT,
} from "./resources";

// The tasks-core entities by reference (`exposes` declarations). See
// ./entity-refs.ts.
export {
  attemptDeliveriesEntityRef,
  attemptsEntityRef,
  conversationsEntityRef,
  pushesEntityRef,
  taskDependenciesEntityRef,
  tasksEntityRef,
} from "./entity-refs";

export { buildTaskPrompt } from "./build-task-prompt";

// The single dependency-graph value object + settled predicate. Every traversal
// (badge counts, drop sets, the launch gate, cycle checks, the graph view)
// derives from this one model. See ./task-graph.ts.
export {
  TaskGraph,
  isSettled,
  SETTLED_STATUSES,
  isBlockedStatus,
  BLOCKED_STATUSES,
} from "./task-graph";
export type { TaskNode } from "./task-graph";

export { tasksRootRoute, taskDetailRoute } from "./routes";
