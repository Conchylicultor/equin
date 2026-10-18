import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { View } from "@plugins/database/plugins/derived-views/server";
import { IdKinds } from "@plugins/ids/server";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { TASK_ROLLUPS } from "./internal/rollup-spec";
import {
  taskRowsServed,
  taskDescriptionsServed,
  attemptRowsServed,
  attemptWorkspacesServed,
  pushRowsServed,
  conversationsActiveServed,
  conversationsSystemServed,
  conversationsGoneServed,
  conversationsByIdServed,
} from "./internal/resources";
import { attempts, conversations, taskBlocking, tasks } from "./internal/views";
import {
  attemptIdKind,
  conversationIdKind,
  taskIdKind,
} from "@plugins/tasks/plugins/task-ids/core";
import {
  pushLanded,
  taskStatusChanged,
  taskTitleChanged,
  conversationStatusChanged,
} from "./internal/tables-events";
import { sweepOrphanedAttempts } from "./internal/sweep-orphaned-attempts";
import { PushLedger } from "./internal/push-ledger/service";

// Per-domain attachment link handles (FK cascade on owner deletion). In their
// own file so they don't leak server-only imports into tasks-core/shared.
// The underlying pgTables stay in `internal/` — only the handles are exported.
export {
  taskAttachments,
  conversationAttachments,
} from "./internal/schema-attachments";
export {
  _tasks,
  _attempts,
  _attemptDeliveries,
  _conversations,
  pushes,
} from "./internal/tables";
// A conversation's owner joins (attempt → task) and the owner columns bound over
// them — the one spelling every routed conversation collection reads.
export {
  conversationOwnerJoins,
  conversationOwnerColumns,
} from "./internal/conversation-owner";
// The derived `tasks_v` relation. A task's `status` is COMPUTED there and exists
// as no column of `tasks`, so a consumer that needs the status of a SET of tasks
// in one query has nowhere else to read it — and a `tasks_v` read costs the same
// whether it asks for one id or fifty, so per-id reads turn a page read into one
// full-graph round trip per linked task. Built on the same derivations as the
// live `tasks` set (./internal/derived.ts), which reads the base tables instead.
// Today's consumers are `page/annotations/todo/task-link`'s markdown provider
// and `tasks/automations`' open-task lookup (read by the `automations.catalog`
// live value). A legacy live reader of `tasks_v` is reached through the view's
// relation bases — the rollups expand to the `conversations` and `pushes`
// writes that move them (change-feed's `relationBases`) — at one FULL reload
// per such write.
export { tasks as tasksView } from "./internal/views";

// Zod schemas and TS types
export {
  TaskSchema,
  TaskListItemSchema,
  TaskStatusSchema,
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

// Resources (all owned here)
export type { AttemptWithConversations, ConversationSummary } from "../core";

// Query functions — reads
export {
  listTasks,
  getTask,
  hasBlockingDep,
  listBlockingDepIds,
  listDependentIds,
  getTaskDependencyIds,
  findNextRankInFolder,
  isDescendant,
  taskDependsOn,
} from "./internal/queries/tasks";

export {
  listAttempts,
  getAttempt,
  getAttemptRow,
  listAttemptsForTask,
  hasAttemptDelivery,
} from "./internal/queries/attempts";

export {
  listConversationsForInfra,
  listExistingConversationIds,
  listConversationsForDisplay,
  listConversationIdsForAttempt,
  listActiveConversations,
  listRetainedConversations,
  getConversation,
  getConversationRuntime,
  getConversationClaudeSessionId,
  listHibernationCandidates,
  RECENT_GONE_LIMIT,
} from "./internal/queries/conversations";

// Only the accessors that guarantee a ledger covering `main` before they read.
// The projection's own ungated reads stay internal by construction — see
// ./internal/push-ledger/raw-reads.ts.
export {
  listPushesForAttempt,
  listPushesByPushId,
} from "./internal/queries/pushes";
export { PushLedger } from "./internal/push-ledger/service";
export type { PushLedgerImpl } from "./internal/push-ledger/service";

// Mutation functions — writes (live-state invalidation is DB-feed-driven)
export {
  createTask,
  updateTask,
  updateTaskTitle,
  dropTaskTree,
  addTaskDependency,
  removeTaskDependency,
} from "./internal/mutations/tasks";
export type {
  CreateTaskInput,
  UpdateTaskPatch,
} from "./internal/mutations/tasks";

// Monotone dependency-tree membership (`tasks.clusterId`). Every writer of a
// membership edge (dependency edge or `folderId`) must union at or before the
// edge write; nothing ever un-unions.
export {
  clusterLabelOf,
  unionTaskClusters,
} from "./internal/mutations/clusters";

export { createAttempt, deleteAttempt } from "./internal/mutations/attempts";
export type { CreateAttemptInput } from "./internal/mutations/attempts";

export {
  insertConversation,
  insertConversationOnConflictDoNothing,
  updateConversation,
  updateConversationsTitleForTask,
  deleteConversationRow,
  markConversationGone,
  markConversationClosed,
  setConversationHibernated,
  touchConversationViewed,
} from "./internal/mutations/conversations";
export type {
  InsertConversationInput,
  UpdateConversationPatch,
} from "./internal/mutations/conversations";

export { insertPush } from "./internal/mutations/pushes";
export { recordScratchDelivery } from "./internal/mutations/deliveries";
export type { InsertPushInput } from "./internal/mutations/pushes";

// Event emitted after a push row is inserted. Consumers subscribe via
// @plugins/infra/plugins/events/server `trigger({ on: pushLanded, do: <job> })`.
export { pushLanded, _pushLandedTriggers } from "./internal/tables-events";
export type { PushLandedPayload } from "./internal/tables-events";

// Emitted when a task's computed status flips. Filterable by taskId and
// status so consumers can subscribe to a specific transition (e.g. parent
// task X reaching status='done').
export {
  taskStatusChanged,
  _taskStatusChangedTriggers,
} from "./internal/tables-events";
export type { TaskStatusChangedPayload } from "./internal/tables-events";

// Emitted at every write of a task's title (create, edit, the Haiku CAS
// upgrade). Filterable by taskId.
export {
  taskTitleChanged,
  _taskTitleChangedTriggers,
} from "./internal/tables-events";
export type { TaskTitleChangedPayload } from "./internal/tables-events";

// Emitted at the conversation status-write chokepoint whenever a single
// conversation's status column changes. Finer-grained than taskStatusChanged;
// the queue plugin subscribes to revalidate the focus pin.
export {
  conversationStatusChanged,
  _conversationStatusChangedTriggers,
} from "./internal/tables-events";
export type { ConversationStatusChangedPayload } from "./internal/tables-events";

// Coalesce a multi-edge dependency mutation to one DB transaction and at most
// one net tasks.statusChanged per affected task. Consumers thread the provided
// `tx` (a DbExecutor) to the dependency mutations they call. (The same batch
// joined onto a transaction the caller already owns, `runStatusBatchOn`, is
// published from `server/testing`.)
//
// There is deliberately no exported "snapshot the status / emit if it changed"
// pair any more: naming the affected tasks was the defect (an edge write can
// only name its own endpoint), so the recording is now internal to
// `withTaskStatusChange`, which derives the affected set from the graph and
// brackets the write itself.
export { withTaskStatusBatch } from "./internal/status-batch";

// Announces an attempt the boot sweep found with no conversation — a broken
// launch invariant. A higher plugin registers the mapping to a report.
export { orphanedAttemptSink } from "./internal/sweep-orphaned-attempts";
export type { OrphanedAttempt } from "./internal/sweep-orphaned-attempts";

export type { DbExecutor } from "./internal/status-batch";

export {
  adoptOrphanConversation,
  dropTaskIfNoActiveSibling,
} from "./internal/mutations/cross-table";
export type { AdoptOrphanInput } from "./internal/mutations/cross-table";

export default {
  description:
    "Schema + repository layer for the tasks/attempts/conversations FK cluster.",
  loadBearing: true,
  contributions: [
    IdKinds.Kind({ kind: taskIdKind }),
    IdKinds.Kind({ kind: attemptIdKind }),
    IdKinds.Kind({ kind: conversationIdKind }),
    ...taskRowsServed.declare,
    ...taskDescriptionsServed.declare,
    ...attemptRowsServed.declare,
    ...attemptWorkspacesServed.declare,
    ...pushRowsServed.declare,
    ...conversationsActiveServed.declare,
    ...conversationsSystemServed.declare,
    ...conversationsGoneServed.declare,
    ...conversationsByIdServed.declare,
    ...TASK_ROLLUPS.map((r) => DerivedTable(r)),
    View({ view: attempts }),
    View({ view: conversations }),
    View({ view: taskBlocking, dependsOn: ["attempts_v"] }),
    View({ view: tasks, dependsOn: ["task_blocking_v"] }),
  ],
  register: [
    pushLanded,
    taskStatusChanged,
    taskTitleChanged,
    conversationStatusChanged,
  ],
  onReady: async () => {
    // The ledger's boot catch-up: whatever landed on `main` while this backend
    // was down. `onReady` and not a warm-up, because a warm-up is contractually
    // an OPTIMIZATION the executor may skip — and this is the cold half of a
    // correctness guarantee. Bounded by the ledger's own high-water mark, so a
    // steady-state boot walks a day of commits and inserts nothing.
    await Promise.all([
      sweepOrphanedAttempts(),
      PushLedger.get().ensureFresh(),
    ]);
  },
} satisfies ServerPluginDefinition;
