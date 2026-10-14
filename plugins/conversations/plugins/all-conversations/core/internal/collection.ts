import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  conversationsEntityRef,
  tasksEntityRef,
} from "@plugins/tasks/plugins/tasks-core/core";
import { CONVERSATION_SORTABLE } from "./fields";

// The two lists share one shape; each is its own collection because a
// collection's `columnScope` is the one DataView surface whose custom columns
// sort and filter it (asserted equal to the surface's `storageKey` at mount).
// Declared by FIELDS: every list field — its label, type, options, filter
// domain — is the conversations entity's (`pick`) or one of the owners' joined
// columns (`fields`), so the lists name none of them.
//
// A row is what the lists render, sort, filter and search — the conversation's
// own columns plus its owners' (`worktreePath`, `taskId`, and the task's
// current `taskTitle`). It leaves out what no list reads — `active`,
// `waitingFor`, `lastViewedAt`, `claudeSessionId`, `closeRequested`,
// `hibernatedAt`, `attemptId` — so the tmux poller's `waitingFor` /
// `lastViewedAt` writes fall outside every list's route gate and load nothing.

/** The conversation fields a list shows, in list order. */
const CONVERSATION_LIST_PICK = [
  "title",
  "status",
  "model",
  "kind",
  "runtime",
  "createdAt",
  "updatedAt",
  "endedAt",
] as const;

/**
 * The owners' columns a list shows: the attempt's worktree, and the owning
 * task's CURRENT title (joined live: a task rename reaches every list holding
 * its conversations). Searchable and filterable; no facet — a facet over a
 * joined text column would recount on every rename.
 */
const CONVERSATION_LIST_OWN_FIELDS = {
  worktreePath: textField({ label: "Worktree" }),
  taskTitle: textField({ label: "Task" }),
};

/** What a row carries that no list shows. */
const CONVERSATION_LIST_CARRY = {
  pick: ["id", "spawnedBy"],
  fields: { taskId: textField() },
} as const;

const CONVERSATION_LIST_DEFAULT = {
  orderBy: [["createdAt", "desc"]],
  limit: 100,
} as const;
const CONVERSATION_LIST_MAX_LIMIT = 500;
/**
 * What a list row reaches beyond the conversation itself (its own exposures —
 * usage — fold as `from`'s): its task (`task`, the owner joins' lookup — its
 * track). Every field an extension of either exposes sorts, filters and groups
 * the lists server-side.
 */
const CONVERSATION_LIST_RELATED = { task: tasksEntityRef } as const;

/**
 * The All-conversations pane's list: every conversation, newest first, read as
 * live key-range pages and kept fresh by the routed change feed — a
 * conversation write refills that row, an attempt's worktree / task move
 * refills its conversations, a task rename refills the task's conversations a
 * window holds. System conversations are hidden by a DEFAULT scope (served
 * with `defaults: [{ unless: "kind", … }]`): a view that filters on Kind gets
 * exactly what it asks for, system rows included.
 */
export const allConversations = liveCollection("conversations.all", {
  from: conversationsEntityRef,
  pick: CONVERSATION_LIST_PICK,
  fields: CONVERSATION_LIST_OWN_FIELDS,
  carry: CONVERSATION_LIST_CARRY,
  related: CONVERSATION_LIST_RELATED,
  id: "id",
  sortable: CONVERSATION_SORTABLE,
  default: CONVERSATION_LIST_DEFAULT,
  maxLimit: CONVERSATION_LIST_MAX_LIMIT,
  columnScope: "all-conversations",
  // Counted: the list's section count is exact while only its scope applies.
  count: true,
});

/**
 * The sidebar History list (a source of the merged `conversations-sidebar`
 * DataView): every conversation, system ones included — the authored "Hide
 * system" filter preset is how a view drops them. Same shape and routes as
 * {@link allConversations}, no default scope.
 */
export const conversationHistory = liveCollection("conversations.history", {
  from: conversationsEntityRef,
  pick: CONVERSATION_LIST_PICK,
  fields: CONVERSATION_LIST_OWN_FIELDS,
  carry: CONVERSATION_LIST_CARRY,
  related: CONVERSATION_LIST_RELATED,
  id: "id",
  sortable: CONVERSATION_SORTABLE,
  default: CONVERSATION_LIST_DEFAULT,
  maxLimit: CONVERSATION_LIST_MAX_LIMIT,
  columnScope: "conversations-sidebar",
  // Counted: the list's section count is exact while only its scope applies.
  count: true,
});

/**
 * A row as the two live lists deliver it: the list row plus every exposed
 * field under `$columns` (both collections reach entities).
 */
export type ConversationListLiveRow =
  typeof allConversations extends LiveRowsCollection<infer R> ? R : never;

/** One row of a conversation LIST (All-conversations, sidebar History), its exposed fields aside. */
export type ConversationListRow = Omit<ConversationListLiveRow, "$columns">;
