import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { IdKinds } from "@plugins/ids/server";
import {
  conversationCreated,
  taskStatusChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import { handleReorder } from "./internal/handle-reorder";
import { handlePromote } from "./internal/handle-promote";
import { handleDemote } from "./internal/handle-demote";
import { handleStepDown } from "./internal/handle-step-down";
import { handleRerank } from "./internal/handle-rerank";
import { handleFile } from "./internal/handle-file";
import {
  handleCreateSection,
  handleRenameSection,
  handleMoveSection,
  handleDeleteSection,
} from "./internal/handle-sections";
import { seedRankJob } from "./internal/seed-rank-job";
import { taskStatusRerankJob } from "./internal/task-status-rerank-job";
import { sweepGoneRanksJob } from "./internal/sweep-gone-ranks-job";
import { queueRanksServed, queueSectionsServed } from "./internal/resource";
import { repairBlockedOrder } from "./internal/repair-blocked-order";
import {
  reorderQueue,
  promoteQueue,
  demoteQueue,
  stepDownQueue,
  rerankQueue,
  fileQueue,
  createQueueSection,
  renameQueueSection,
  moveQueueSection,
  deleteQueueSection,
  conversationSectionIdKind,
} from "../core";

export { conversationsQueue, _conversationSections } from "./internal/tables";
export { seedRankJob } from "./internal/seed-rank-job";
export { Queue } from "./internal/launch-section";
export type { QueueLaunchSection } from "./internal/launch-section";
export {
  lockDeck,
  rankForTop,
  rankForBottom,
  rankAfterN,
  rankAdjacentTo,
  rankAfterBlockers,
  endRank,
  findTaskIdForConversation,
  reseatGroupMembers,
  upsertRank,
  seatJoiningGroup,
  setGroupSection,
} from "./internal/queue-ranks";

export default {
  description:
    "Stable-rank global queue. Ranks seeded once on creation (newest first). A user files a conversation's task group into a section — Pinned (built in, first) or one of their own sections (conversation_sections, served as queue-sections) — or leaves it in the Queue.",
  contributions: [
    ...queueRanksServed.declare,
    ...queueSectionsServed.declare,
    IdKinds.Kind({ kind: conversationSectionIdKind }),
    Trigger({
      on: conversationCreated,
      do: seedRankJob,
      with: {},
      oneShot: false,
    }),
    // Task blocked/unblocked is a rank change with no conversation status change
    // behind it, so it needs its own trigger.
    Trigger({
      on: taskStatusChanged,
      do: taskStatusRerankJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [seedRankJob, taskStatusRerankJob, sweepGoneRanksJob],
  httpRoutes: {
    [reorderQueue.route]: handleReorder,
    [promoteQueue.route]: handlePromote,
    [demoteQueue.route]: handleDemote,
    [stepDownQueue.route]: handleStepDown,
    [rerankQueue.route]: handleRerank,
    [fileQueue.route]: handleFile,
    [createQueueSection.route]: handleCreateSection,
    [renameQueueSection.route]: handleRenameSection,
    [moveQueueSection.route]: handleMoveSection,
    [deleteQueueSection.route]: handleDeleteSection,
  },
  onReady: repairBlockedOrder,
} satisfies ServerPluginDefinition;
