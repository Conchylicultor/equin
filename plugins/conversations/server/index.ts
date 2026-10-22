import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleList } from "./internal/handle-list";
import { handleDelete } from "./internal/handle-delete";
import { handleGet } from "./internal/handle-get";
import { handleListTurns } from "./internal/handle-list-turns";
import {
  listConversations,
  getConversation,
  deleteConversation,
  listConversationTurns,
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
  maybeLaunchOnArmedJob,
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
import { conversationTurnCompleted } from "./internal/tables-turn-completed-event";
import {
  conversationCreated,
  conversationStatusChanged,
  taskStatusChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskAutoStartArmed } from "@plugins/tasks/plugins/auto-start/server";

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

export default {
  description:
    "Conversation domain: shared server code and types; view plugins live under `plugins/`.",
  loadBearing: true,
  httpRoutes: {
    [listConversations.route]: handleList,
    [getConversation.route]: handleGet,
    [deleteConversation.route]: handleDelete,
    [listConversationTurns.route]: handleListTurns,
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
      on: taskAutoStartArmed,
      do: maybeLaunchOnArmedJob,
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
    conversationSpawnFailedKind,
    claudeCodeUnavailableAtSpawnKind,
    autoStartModelUnavailableKind,
    heldTurnUndeliveredKind,
  ],
  register: [
    maybeLaunchTaskJob,
    maybeLaunchOnStatusJob,
    maybeLaunchOnArmedJob,
    notifyConversationCreatedJob,
    turnEmitterReconcileJob,
    spawnConversationJob,
    deliverHeldTurnsJob,
    conversationTurnCompleted,
    conversationsStatusSweepJob,
  ],
  onReady: async () => {
    registerOrphanedAttemptReport();
    await startStatusReconciler();
    await startTurnEmitter();
  },
} satisfies ServerPluginDefinition;
