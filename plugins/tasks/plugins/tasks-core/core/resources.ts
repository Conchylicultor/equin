import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import {
  AttemptStatusSchema,
  TASK_STATUS_OPTIONS,
  TASK_STATUS_ORDER,
} from "./internal/schema";
import { ConversationSummarySchema } from "./schemas";
import {
  attemptDeliveriesEntityRef,
  attemptsEntityRef,
  conversationsEntityRef,
  pushesEntityRef,
  tasksEntityRef,
} from "./entity-refs";
import { attemptFields } from "./internal/fields";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { rankValueField } from "@plugins/fields/plugins/rank/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";

// The `conversations-gone` window's default size (the newest ended
// conversations the queue's Done section and the welcome recents show).
export const RECENT_GONE_LIMIT = 30;

// Client/shared live-state declarations for the tasks/attempts FK cluster. THE
// single source of truth for each resource's key / schema / keyed-ness: the
// tasks-core *server* resources are served from these (`serveCollection`), so
// the server cannot drift from the client (a server `mode: "keyed"` against a
// client descriptor that forgot its `keyOf` is a guaranteed client crash with
// no compile-time signal).
//
// They live in `tasks-core/core` — next to the schemas they build on — rather
// than in the `tasks` umbrella, so the tasks-core server
// can import them without forming a `tasks ⇄ tasks-core` plugin cycle. Consumers
// import these directly from `@plugins/tasks/plugins/tasks-core/core`.
// The task row both task collections deliver (`taskRows`, `taskClusterRows`),
// one spelling each declaration names (the scanners read a spec's own keys,
// so the pieces are shared rather than the spec spread).
const TASK_ROW_PICK = ["title", "updatedAt"] as const;
// `status` is ordinal: a list sorts it by `TASK_STATUS_ORDER` (open to
// settled), on the tree's server window and in memory alike.
const TASK_ROW_FIELDS = {
  status: enumTextField(TASK_STATUS_ORDER, {
    label: "Status",
    options: TASK_STATUS_OPTIONS,
    ordered: true,
  }),
};
const TASK_ROW_CARRY = {
  pick: [
    "id",
    "folderId",
    "groupId",
    "clusterId",
    "titleAuto",
    "author",
    "droppedAt",
    "heldAt",
    "createdAt",
  ],
  fields: {
    // The wire `Rank` value object over the stored key (`rankValueField`).
    rank: rankValueField(),
    active: boolField(),
    finishedAt: nullable(dateField()),
    dependencies: stringListField(),
  },
} as const;

// Tree order: `rank`, then `createdAt` (the id breaks ties).
const TASK_ROW_ORDER = [
  ["rank", "asc"],
  ["createdAt", "asc"],
] as const;

// The tree's spelling of the same row (`taskWindow`): `folderId` LISTED, since
// a tree's parent is a filterable field — the wire row is the same.
const TASK_TREE_PICK = [...TASK_ROW_PICK, "folderId"] as const;
const TASK_TREE_CARRY = {
  pick: [
    "id",
    "groupId",
    "clusterId",
    "titleAuto",
    "author",
    "droppedAt",
    "heldAt",
    "createdAt",
  ],
  fields: TASK_ROW_CARRY.fields,
} as const;

// The tasks as a bounded WINDOW (`rank`, then `createdAt`; 100 / 500), read
// today by id (`useLive(taskRows, { id })` / `{ ids }`, its `:rows`): the
// chips, referents, the task pane and the sidebar queue. No reader holds
// every task — the edge walkers read one cluster (`taskClusterRows`), the task
// list and the sidequest launch list the tree (`taskWindow`) — so the set is
// never shipped whole: it was an `all` set preloaded at boot, 5.55 MB of every
// boot snapshot and restart replay on main (6,778 rows, 2026-11-05;
// research/2026-11-05-tasks-bounded-task-rows.md, step 5). Served over the
// base table and its materialized aggregates (`../server/internal/task-rows.ts`):
// a task write is its own row's refill, a write that moves a stored aggregate
// (an attempt / conversation / push, an edge, a prerequisite's facts) the
// refill of each task whose side row changed.
//
// Declared by FIELDS over the `tasks` entity (`from: tasksEntityRef`): the
// task list's fields — the title and last update (`pick`), the derived
// `status` (an own field, bound by `../server/internal/task-rows.ts`) — carry
// their labels, types and options, so no list builds them (the in-memory task
// DataViews derive theirs from this collection); and every field a task
// extension exposes (its track, category, automation origin) folds into each
// row under `$columns` (the base exposures) — a window reaches them, a
// lookup-only collection would not.
//
// The wire row is `TaskListItem` — every `tasks_v` column but the heavy
// `description` (read per task from `taskDescriptions` below) — plus the
// additive `$columns`. Key `tasks.v2`: the old `tasks` was a param-less whole
// set (preloaded at boot), so a tab still running a bundle that declared it
// subscribes a key no longer served and is refused (C39). A removed, renamed
// or retyped field must rename the key.
//
// Not preloaded; its `:rows` sibling is preloaded at the live conversations'
// tasks (`../server/internal/resources.ts`). Named `taskRows` because `tasks`
// is the server's view handle.
export const taskRows = liveCollection("tasks.v2", {
  from: tasksEntityRef,
  pick: TASK_ROW_PICK,
  fields: TASK_ROW_FIELDS,
  carry: TASK_ROW_CARRY,
  id: "id",
  sortable: ["rank", "createdAt", "updatedAt", "title"],
  default: { orderBy: TASK_ROW_ORDER, limit: 100 },
  maxLimit: 500,
  // The `:rows` id-set cap. The sidebar queue reads the tasks of every LIVE
  // conversation by id (`conversationsActive`, a whole set — ~30 today), as
  // `queueRanks` reads their ranks: 2000 is far over any live set, still bounded.
  maxIds: 2000,
});

/**
 * The most tasks one dependency cluster may hold — a declared, checked bound,
 * not an observation. Clusters only grow, and only by union, and the database
 * refuses a union that would cross it (`tasks_union_clusters`,
 * `../server/internal/cluster-triggers.ts`), so no cluster can exceed it and
 * `taskClusterRows` reads at most this many rows. Largest on main: 137
 * (2026-11-05).
 */
export const TASK_CLUSTER_MAX = 500;

// One dependency cluster's tasks (`useLive(taskClusterRows, { where: {
// clusterId } })`), the same rows as `taskRows` (one spec, one server binding:
// `taskRowsServeOptions`). `clusterId` is the monotone union-find label: the
// database unions on every dependency, folder and group edge write and refuses
// a label write leaving an edge across clusters (`../server/internal/cluster-triggers.ts`),
// so a reader walking those edges from one task — the dependency graph, the
// deps tree, the dependency card, the draft popover's relate — needs exactly
// its task's cluster. A surface about ONE task: a per-row reader of a list
// reads a stored per-task value by id instead (`taskActiveDependentCounts`). Bounded by TASK_CLUSTER_MAX, which
// the union enforces. A union moves the loser's rows out of its tuple into the
// winner's.
export const taskClusterRows = liveCollection("task-cluster", {
  from: tasksEntityRef,
  pick: TASK_ROW_PICK,
  fields: TASK_ROW_FIELDS,
  carry: TASK_ROW_CARRY,
  id: "id",
  all: {
    by: ["clusterId"],
    orderBy: TASK_ROW_ORDER,
    max: TASK_CLUSTER_MAX,
  },
});

// How many ACTIVE tasks transitively depend on each task, by id
// (`useLive(taskActiveDependentCounts, { id })`): the "N blocked" count a
// conversation row's chip, the conversation toolbar's Tasks button and the
// drop-dependents action show. Lookup-only, over a stored count
// (`task_active_dependents`, a materialized closure over the dependency edges
// walked dependent-ward: `../server/internal/task-rows.ts`), so a list of rows
// showing it holds one number per row on screen — never each row's whole
// dependency cluster (38 `task-cluster` tuples, 0.39 M chars of a Tasks-pane
// restart replay, 2026-11-05). A task the read does not find is `found: false`.
export const taskActiveDependentCounts = liveCollection(
  "task-active-dependents",
  {
    from: tasksEntityRef,
    carry: {
      pick: ["id"],
      fields: { activeDependents: intField({ min: 0 }) },
    },
    baseExposures: false,
    id: "id",
  },
);

/** A task as `taskRows` delivers it: a `TaskListItem` and its exposed fields under `$columns`. */
export type TaskRow =
  typeof taskRows extends LiveRowsCollection<infer R> ? R : never;

// The tasks TREE: the same task row as a WINDOW — a bounded read that filters
// and sorts on the server, `status` included: its derived fields are stored
// aggregates (`../server/internal/task-rows.ts`: query-resource's
// `materializeJoin`), so a write anywhere in a task's attempts or
// prerequisite closure reaches a window as a write to the task's side rows,
// and moves it in or out. Filterable by every listed field and every folded
// exposure (`track`, `category`, …).
//
// A tree (network/live's `tree`): `folderId` names a task's parent (listed —
// a tree's parent is a filterable field — as "Folder"; the task list hides it
// from its pickers), `rank` orders siblings, so every level is an ordinary
// bounded read (`{ folderId: { isEmpty: true } }` for the roots, `{ folderId:
// x }` for a folder's children), every row carries `$childCount` (the stored
// count of the tasks filed under it) and `tasks.tree:ancestors` answers a
// set of tasks with their folder chains. The task list (task-list's
// `TasksListView`) is a live DataView over it. Default order: the tree's,
// `rank` then `createdAt`; a reader wanting another passes its own `orderBy`.
// Not preloaded. The step towards `taskRows` as a window
// (research/2026-11-05-tasks-bounded-task-rows.md, step 5).
//
// Key `tasks.tree` (it was `tasks.window`, the flat window): the default read
// changed meaning — tree order (`rank`, `createdAt`) instead of newest first —
// so a tab on an older bundle reading the default window under the old key
// would get a different set at its limit. A new key makes such a tab's read a
// `skew` (the Reload prompt) instead (C39).
export const taskWindow = liveCollection("tasks.tree", {
  from: tasksEntityRef,
  pick: TASK_TREE_PICK,
  fields: TASK_ROW_FIELDS,
  carry: TASK_TREE_CARRY,
  id: "id",
  sortable: ["rank", "createdAt", "updatedAt", "title", "status"],
  default: { orderBy: TASK_ROW_ORDER, limit: 100 },
  maxLimit: 500,
  tree: { parent: "folderId", rank: "rank" },
  // The task list's custom columns sort and filter it on the server, in the
  // scope (the surface) each query names.
  scopedColumns: true,
});

/** A task as the tasks tree (`taskWindow`) delivers it: a {@link TaskRow} and its `$childCount`. */
export type TaskTreeRow =
  typeof taskWindow extends LiveRowsCollection<infer R> ? R : never;

// One task's `description` — the heavy text the `tasks` set leaves out — read
// by id (`useLive(taskDescriptions, { id })`): lookup-only, so it loads only
// for an open detail pane, and a description autosave is that one row's
// refill. A task the read does not find is `found: false`. Served over the
// `tasks` table in `../server/internal/resources.ts`.
export const taskDescriptions = liveCollection("task-descriptions", {
  from: tasksEntityRef,
  carry: { pick: ["id", "description"] },
  baseExposures: false,
  id: "id",
});
// One task's attempts — a scoped set (`all: { by: ["taskId"] }`, read with
// `useLive(attemptRows, { where: { taskId } })`), each with its non-system
// conversations (`ConversationSummary`, oldest first): the task's attempt and
// run lists (`../web/hooks.ts`) and the attempt pane read one task's; the
// attempt chip, the attempt-switch button and the worktree's linked task read
// one attempt by id (`{ id }`, the `:rows` point sibling). No reader needs
// every attempt, so none is held whole: an attempt is O(its task's), never
// O(every attempt ever filed) — the whole set was 3.4 MB of every boot
// snapshot and restart replay on main (2026-11-05). Served over the
// `attempts` table, its two rollups and a children `jsonAgg` of its
// conversations (`../server/internal/attempt-rows.ts`), never `attempts_v`:
// an attempt write is its own row's refill, a conversation write its
// attempt's (gated: `waiting_for` / `last_viewed_at` / `updated_at` reach
// nothing), a push its attempt's, an insert an entrant, a delete an exit, a
// write to another task's attempts nothing. Ordered by `createdAt` (the id
// breaks ties).
//
// The wire row is `AttemptWithConversations`. Key `attempts.v2`: the old
// `attempts` was a param-less whole set, so a tab still running a bundle that
// declared it subscribes a key no longer served and is refused, rather than
// passing a params gate it cannot name (C39). A change to the row must rename
// the key.
//
// Named `attemptRows` because `attempts` is the server's view handle.
export const attemptRows = liveCollection("attempts.v2", {
  from: attemptsEntityRef,
  // `workspace` is left off: the workspace crosses the wire on its own lookup
  // (`attemptWorkspaces`), which the values computed from it follow.
  carry: {
    pick: ["id", "taskId", "worktreePath", "createdAt", "updatedAt"],
    fields: {
      status: parsedTextField(AttemptStatusSchema, { default: "pending" }),
      active: boolField(),
      retained: boolField(),
      finishedAt: nullable(dateField()),
      conversations: jsonField({
        schema: wholeList(ConversationSummarySchema, {
          reason: "one attempt's non-system conversations — a handful each",
        }),
        default: [],
      }),
    },
  },
  baseExposures: false,
  id: "id",
  all: {
    by: ["taskId"],
    orderBy: [["createdAt", "asc"]],
    unbounded: {
      reason: "one task's attempts — a handful each (at most 8 on main)",
    },
  },
});
// One attempt's workspace (conversations/workspace: a worktree, or a scratch
// dir and its profile) and checkout by attempt id — lookup-only, read with
// `useLive(attemptWorkspaces, { id: attemptId })` by the surfaces that gate on
// what the workspace offers (the conversation pane's git surfaces), and
// FOLLOWED by `{ ids: [attemptId] }` by the values computed from where an
// attempt runs (`attemptWorkspacesServed`, `../server`: attempt-work,
// commits-graph, code-explorer's files). Its own key rather than a field of
// `attemptRows`, whose readers do not want it. Served over the `attempts` table in
// `../server/internal/resources.ts`.
//
// The row is EXACTLY what its followers read — the workspace, the checkout
// path and the attempt's start (attempt-work's trailer-grep floor) — so a
// write to any other `attempts` column (its task, `updated_at`) is gated out
// of every follower. `worktreePath` / `createdAt` were added after the key
// shipped: an additive change, so a tab on a bundle that read `{ id,
// workspace }` still parses the row (the C39 check in
// `../server/internal/follow-targets-oracle.test.ts`).
export const attemptWorkspaces = liveCollection("attempt-workspaces", {
  from: attemptsEntityRef,
  carry: { pick: ["id", "workspace", "worktreePath", "createdAt"] },
  baseExposures: false,
  id: "id",
});

// ── Follow targets ───────────────────────────────────────────────────────────
//
// The narrow collections a computed value FOLLOWS (network/live's `follows`,
// research/2026-10-24-global-live-narrowed-reads.md §4): each picks exactly
// the columns its followers read and nothing more, because a follow copies
// the collection's own route gate — a write to a column the row does not
// carry reaches no follower. That is why the wide rows (`conversationsById`,
// `attemptRows`) are not followed: every column they carry would recompute
// the follower. Served (and their served handles exported) by
// `../server/internal/follow-targets.ts`; no surface reads them over the wire
// today.

// One attempt's conversations' ids, every kind — a scoped `all` set followed
// by `{ where: { attemptId } }` (attempt-work's and commits-graph's trailer
// filter). A conversation's insert, delete or move between attempts reaches
// the attempts it left and joined; a write to any other column (its status,
// the poller's `waiting_for` / `last_viewed_at`) reaches none.
export const attemptConversationIds = liveCollection(
  "attempt-conversation-ids",
  {
    from: conversationsEntityRef,
    carry: { pick: ["id", "attemptId", "createdAt"] },
    baseExposures: false,
    id: "id",
    all: {
      by: ["attemptId"],
      orderBy: [["createdAt", "asc"]],
      unbounded: {
        reason: "one attempt's conversations — a handful each",
      },
    },
  },
);

// An attempt's task, by attempt id — the first hop of a value keyed by
// attempt that reads its task's rows (task-source-url): followed by
// `{ ids: [attemptId] }`, its task then followed by the `taskId` read here
// (`follow.from`). An attempt never changes task, so only its insert or
// delete reaches a follower.
export const attemptTasks = liveCollection("attempt-tasks", {
  from: attemptsEntityRef,
  carry: { pick: ["id", "taskId"] },
  baseExposures: false,
  id: "id",
});

// Whether each task is dropped, by id — what a value choosing among several
// tasks by liveness reads (task-subject's live task): a drop or restore of a
// followed task reaches its followers, any other task write (a title, a
// status, `updated_at`) reaches none.
export const taskDroppedStates = liveCollection("task-dropped-states", {
  from: tasksEntityRef,
  carry: { pick: ["id", "droppedAt"] },
  baseExposures: false,
  id: "id",
});

// One attempt's pushes' ids — a scoped `all` set followed by
// `{ where: { attemptId } }` (attempt-work's ledger count). `pushRows` is a
// window: a window has no per-tuple match to follow by.
export const attemptPushIds = liveCollection("attempt-push-ids", {
  from: pushesEntityRef,
  carry: { pick: ["id", "attemptId", "createdAt"] },
  baseExposures: false,
  id: "id",
  all: {
    by: ["attemptId"],
    orderBy: [["createdAt", "asc"]],
    unbounded: {
      reason: "one attempt's pushes — at most a handful each",
    },
  },
});

// Whether an attempt recorded a non-push delivery — lookup-only by the
// attempt's id (`attempt_deliveries` is keyed by it), followed by
// `{ ids: [attemptId] }` (attempt-work's no-git standing): a row is the fact,
// its absence the lack of one. Carries the key alone, so a later delivery's
// summary rewrite reaches no follower.
export const attemptDeliveries = liveCollection("attempt-deliveries", {
  from: attemptDeliveriesEntityRef,
  carry: { pick: ["attemptId"] },
  baseExposures: false,
  id: "attemptId",
});

// Where a conversation runs — its attempt's checkout path and workspace —
// lookup-only by the conversation's id, followed by `{ ids: [id] }` (the
// worktree values: edited-files, allow-files, plugin-changes). Over the
// `conversations` table with its attempt joined (`conversationAttemptJoin`):
// a conversation's move to another attempt refills it, an attempt's
// `worktree_path` / `workspace` write reaches the conversations of that
// attempt. Owned here, not by conversations/workspace (which cannot import
// tasks-core: a cycle — tasks-core's fields store its spec).
export const conversationWorkspaces = liveCollection(
  "conversation-workspaces",
  {
    from: conversationsEntityRef,
    carry: {
      pick: ["id", "attemptId"],
      fields: {
        worktreePath: attemptFields.worktreePath,
        workspace: attemptFields.workspace,
      },
    },
    baseExposures: false,
    id: "id",
  },
);

/**
 * The workspace a followed `conversationWorkspaces` tuple names — its one
 * row — or `null`: no row (a conversation subscribed before its row is
 * written) or no checkout path yet. The one reading every follower of it
 * shares, so they cannot disagree on what "no worktree" is.
 */
export function conversationWorkspaceOf<
  R extends { readonly worktreePath: string },
>(rows: readonly R[]): R | null {
  if (rows.length > 1) {
    throw new Error(
      `conversationWorkspaces: ${rows.length} rows for one conversation id`,
    );
  }
  const row = rows[0];
  return row === undefined || row.worktreePath === "" ? null : row;
}

// A conversation's live Claude session id (the chain's tail before the chain
// records it) — lookup-only, followed by `{ ids: [id] }` (the transcript
// family's chain, beside session-chain's `conversationSessions`).
export const conversationSessionTails = liveCollection(
  "conversation-session-tails",
  {
    from: conversationsEntityRef,
    carry: { pick: ["id", "claudeSessionId"] },
    baseExposures: false,
    id: "id",
  },
);

// A conversation's runtime and status — lookup-only, followed by
// `{ ids: [id] }`: which agent runtime runs a conversation, and whether it
// still runs.
export const conversationRuntimes = liveCollection("conversation-runtimes", {
  from: conversationsEntityRef,
  carry: { pick: ["id", "runtime", "status"] },
  baseExposures: false,
  id: "id",
});
// The `pushes` ledger as a live collection: one row per landed commit sha.
// Every push surface is attempt-scoped, so it reads ONE attempt's rows —
// `useLive(pushRows, { where: { attemptId } })` — newest first by default. A
// filter, not a slice of a global recent window, so an arbitrarily old attempt
// still finds its pushes (filtering the global window dropped them once they
// fell out of it: a wrong "No pushes yet", a destructive drop-vs-complete
// mis-gate). An attempt holds a handful of pushes (at most 5 on main), so the
// default 100 never truncates one. Not preloaded — route-scoped.
//
// Named `pushRows` because `pushes` is the table handle on the server. The
// `attempts` set does not read it: a push reaches its attempt through the
// `attempt_push_agg` rollup's source route on `pushes`.
export const pushRows = liveCollection("pushes", {
  from: pushesEntityRef,
  pick: ["attemptId"],
  carry: {
    pick: ["id", "conversationId", "sha", "pushId", "message", "createdAt"],
  },
  // Its wire rows stay the ledger's own columns: no extension exposes a push.
  baseExposures: false,
  id: "id",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
});

// The conversation lists, as three collections over the `conversations` table
// with its owners joined (attempt → task) — never `conversations_v` — plus a
// by-id read. The rows are
// the full `Conversation` (every column, the owners' `worktreePath` / `taskId`
// / `taskTitle`, and `active` = `status <> 'done'`), served in
// `../server/internal/conversation-rows.ts`.
//
// `conversations-active` and `conversations-system` are WHOLE ordered sets
// (`all`): the queue, the welcome counts and the destructive-default slices
// (`useHasActiveSiblings`) read every live conversation. A conversation write
// is its own row's refill (the poller's `waiting_for` included — a one-row
// refill), a close or a kind change a where-flip exit, an insert an entrant,
// an attempt's worktree / task move or a task rename the refill of the
// conversations it owns — never a whole-set reload, and a task or attempt
// write no field reads (a hold, a status flip) loads nothing (W4).
//
// The keys are the legacy ones: a tab still running a bundle that declared
// `conversations-active` as an old param-less keyed descriptor over
// `ConversationSchema` subscribes `{}`, passes the `all` gate and
// parses these rows with its own (identical) schema — the C39 old-bundle
// check, pinned by `../server/internal/tree-oracle.test.ts`. A change to the
// row must rename the keys.
//
// Boot-critical (`preload: "boot"`): the queue and the welcome view paint from
// the boot snapshot.
//
// Both queue reads (`conversations-active`, `conversations-gone`) are declared
// by FIELDS over the `conversations` entity: the Queue lists exactly the
// fields the conversation lists do (`CONVERSATION_QUEUE_PICK` + the owners'
// joined columns), derived from the entity, and the row carries every other
// column the full `Conversation` has (`carry`) — the wire row is the same.
//
// They reach their TASK (`related`, over the owner joins' `task` lookup):
// every field a task extension exposes (its track) rides each row under
// `$columns`, so the Queue filters and groups by it in memory with no list
// code. The conversation's own exposures (`baseExposures: false`) are left off
// on purpose: usage upserts on every transcript append, and folding it into
// this boot-preloaded set would push a diff to every client per append — the
// Queue shows no usage.
const QUEUE_RELATED = { task: tasksEntityRef } as const;

/** The conversation fields the Queue lists, in list order. */
const CONVERSATION_QUEUE_PICK = [
  "title",
  "status",
  "model",
  "kind",
  "runtime",
  "createdAt",
  "updatedAt",
  "endedAt",
] as const;

/** The owners' columns the Queue lists: the attempt's worktree, the task's current title. */
const CONVERSATION_QUEUE_OWN_FIELDS = {
  worktreePath: textField({ label: "Worktree" }),
  taskTitle: textField({ label: "Task" }),
};

/** Every other column a `Conversation` carries — on the row, in no list. */
const CONVERSATION_QUEUE_CARRY = {
  pick: [
    "id",
    "attemptId",
    "claudeSessionId",
    "waitingFor",
    "workingOn",
    "statusUnverifiedSince",
    "statusSince",
    "spawnedBy",
    "closeRequested",
    "hibernatedAt",
    "resumingSince",
    "lastViewedAt",
  ],
  fields: { taskId: textField(), active: boolField() },
} as const;

export const conversationsActive = liveCollection("conversations-active", {
  from: conversationsEntityRef,
  pick: CONVERSATION_QUEUE_PICK,
  fields: CONVERSATION_QUEUE_OWN_FIELDS,
  carry: CONVERSATION_QUEUE_CARRY,
  related: QUEUE_RELATED,
  baseExposures: false,
  id: "id",
  all: {
    orderBy: [["createdAt", "desc"]],
    unbounded: {
      reason:
        "the queue, the welcome counts and the sibling checks behind the exit buttons read every live conversation",
    },
  },
  preload: "boot",
});
// The live `system` conversations (machine-spawned automation): the same
// shape and routes as `conversationsActive`, the other half of `kind`.
export const conversationsSystem = liveCollection("conversations-system", {
  from: conversationsEntityRef,
  pick: CONVERSATION_QUEUE_PICK,
  fields: CONVERSATION_QUEUE_OWN_FIELDS,
  carry: CONVERSATION_QUEUE_CARRY,
  related: QUEUE_RELATED,
  baseExposures: false,
  id: "id",
  all: {
    orderBy: [["createdAt", "desc"]],
    unbounded: {
      reason:
        "the worktree-title lookup reads every live system conversation beside the active ones",
    },
  },
  preload: "boot",
});
// The ended conversations, newest first by `endedAt`: a WINDOW (bounded by
// construction — the history is unbounded), the default the newest
// `RECENT_GONE_LIMIT` (the queue's Done section, the welcome recents), grown
// by a reader that wants more (Recovery reads 50). Read as key-range pages,
// so the queue's Done section pages through the whole history as the user
// scrolls (`useLive` with a viewport: its first page IS the default window). A close
// is an entrant at the top, a restore an exit; it is not L2-persisted (a
// bounded window leaves L2). Its listed fields filter it (derived).
// Boot-critical: the default window paints from the boot snapshot. Counted
// (`count: true`): `useLive(conversationsGone, { count: true })` is how many
// conversations have ended in all — the welcome counts, and the Done
// section's exact count — preloaded with the window, one COUNT per write.
export const conversationsGone = liveCollection("conversations-gone", {
  from: conversationsEntityRef,
  pick: CONVERSATION_QUEUE_PICK,
  fields: CONVERSATION_QUEUE_OWN_FIELDS,
  carry: CONVERSATION_QUEUE_CARRY,
  related: QUEUE_RELATED,
  baseExposures: false,
  id: "id",
  sortable: ["endedAt"],
  default: { orderBy: [["endedAt", "desc"]], limit: RECENT_GONE_LIMIT },
  maxLimit: 500,
  count: true,
  preload: "boot",
});
// One conversation by id, whatever its status or age (`useLive(c, { id })`): the
// conversation pane, every toolbar control and chip that holds an id. A point
// read, so a done conversation older than the newest `RECENT_GONE_LIMIT` is
// found like any other (W9) — no REST fallback. Lookup-only (`:rows` alone,
// never preloaded); a write to row R reaches only the tuples holding R. The
// same full `Conversation` row as the lists, declared by the same fields; it
// reaches no entity (a lookup-only read folds no exposure), so its rows carry
// no `$columns`.
export const conversationsById = liveCollection("conversations.by-id", {
  from: conversationsEntityRef,
  carry: {
    pick: [...CONVERSATION_QUEUE_PICK, ...CONVERSATION_QUEUE_CARRY.pick],
    fields: {
      ...CONVERSATION_QUEUE_OWN_FIELDS,
      ...CONVERSATION_QUEUE_CARRY.fields,
    },
  },
  baseExposures: false,
  id: "id",
});
