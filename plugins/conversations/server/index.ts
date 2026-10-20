import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { CONVERSATIONS_CATEGORY_ID } from "../core/task-category";
import { handleClose } from "./internal/handle-close";
import { handleList } from "./internal/handle-list";
import { handleCreate } from "./internal/handle-create";
import { handleDelete } from "./internal/handle-delete";
import { handleGet } from "./internal/handle-get";
import { handleListTurns } from "./internal/handle-list-turns";
import { handlePostTurn } from "./internal/handle-post-turn";
import { handleStop } from "./internal/handle-stop";
import { handleRetryTurn } from "./internal/handle-retry-turn";
import { handleWithdrawTurn } from "./internal/handle-withdraw-turn";
import {
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  postConversationTurn,
  retryConversationTurn,
  withdrawConversationTurn,
  stopConversation,
  listConversationTurns,
  closeConversation,
} from "../core/endpoints";
import {
  conversationsStatusSweepJob,
  startStatusReconciler,
} from "./internal/status-reconciler";
import { registerOrphanedAttemptReport } from "./internal/orphaned-attempt-report";
import {
  startTurnEmitter,
  turnEmitterReconcileJob,
} from "./internal/turn-emitter";
import {
  maybeLaunchTaskJob,
  maybeLaunchOnStatusJob,
} from "./internal/auto-start-jobs";
import { notifyConversationCreatedJob } from "./internal/notify-created-job";
import { spawnConversationJob } from "./internal/spawn-job";
import {
  deliverHeldTurnsJob,
  heldTurnUndeliveredKind,
} from "./internal/deliver-held-turns-job";
import {
  claudeCodeUnavailableAtSpawnKind,
  conversationSpawnFailedKind,
} from "./internal/spawn-report-kinds";
import { autoStartModelUnavailableKind } from "./internal/auto-start-model-report";
import { conversationCreated } from "./internal/tables-created-event";
import { conversationTurnCompleted } from "./internal/tables-turn-completed-event";
import {
  conversationStatusChanged,
  taskStatusChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";

export { maybeLaunchTaskJob, launchTaskNow } from "./internal/auto-start-jobs";
export type {
  IfAlreadyStarted,
  LaunchTaskNowResult,
} from "./internal/auto-start-jobs";
export {
  createConversation,
  deleteConversation,
  resumeConversation,
  ensureResumed,
  ResumeBlockedError,
  previewRewind,
  rewindConversationAt,
  TranscriptCutError,
} from "./internal/lifecycle";
export type { Turn } from "./internal/claude-transcript";
export {
  Runtime,
  getConversationRow,
  interruptConversation,
  readConversationTurns,
} from "./internal/runtime";
export type {
  RuntimeInfo,
  RuntimeSignal,
  ConversationRuntime,
  SubmitVerdict,
  TypedTurn,
} from "./internal/runtime";
export { submitTurn } from "./internal/turns";
export type { SubmitOutcome, TurnSubmission } from "./internal/turns";
export { requestStatusReconcile } from "./internal/status-reconciler";
export { QuestionHolds } from "./internal/question-hold";
export type {
  QuestionHold,
  QuestionHoldSource,
} from "./internal/question-hold";
export { conversationTurnCompleted } from "./internal/tables-turn-completed-event";
export type { ConversationTurnCompletedPayload } from "./internal/tables-turn-completed-event";
export { afterTurn } from "./internal/after-turn";
export { conversationCreated } from "./internal/tables-created-event";
export type { ConversationCreatedPayload } from "./internal/tables-created-event";

export default {
  description:
    "Conversation domain: shared server code and types; view plugins live under `plugins/`.",
  loadBearing: true,
  httpRoutes: {
    [listConversations.route]: handleList,
    [getConversation.route]: handleGet,
    [createConversation.route]: handleCreate,
    [deleteConversation.route]: handleDelete,
    [postConversationTurn.route]: handlePostTurn,
    [stopConversation.route]: handleStop,
    [retryConversationTurn.route]: handleRetryTurn,
    [withdrawConversationTurn.route]: handleWithdrawTurn,
    [listConversationTurns.route]: handleListTurns,
    [closeConversation.route]: handleClose,
  },
  // The conversations live resources (active/system/gone/gone-stats) are mounted on tasks-core.
  contributions: [
    Trigger({
      on: taskStatusChanged,
      do: maybeLaunchOnStatusJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: conversationCreated,
      do: notifyConversationCreatedJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: conversationCreated,
      do: turnEmitterReconcileJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: conversationStatusChanged,
      do: turnEmitterReconcileJob,
      with: {},
      oneShot: false,
    }),
    TaskCategory({
      id: CONVERSATIONS_CATEGORY_ID,
      label: "Conversations",
      order: 0,
    }),
    TaskCategory({ id: "system", label: "System", order: 1 }),
    conversationSpawnFailedKind,
    claudeCodeUnavailableAtSpawnKind,
    autoStartModelUnavailableKind,
    heldTurnUndeliveredKind,
  ],
  register: [
    maybeLaunchTaskJob,
    maybeLaunchOnStatusJob,
    notifyConversationCreatedJob,
    turnEmitterReconcileJob,
    spawnConversationJob,
    deliverHeldTurnsJob,
    conversationCreated,
    conversationTurnCompleted,
    conversationsStatusSweepJob,
  ],
  onReady: async () => {
    registerOrphanedAttemptReport();
    await startStatusReconciler();
    await startTurnEmitter();
  },
} satisfies ServerPluginDefinition;
