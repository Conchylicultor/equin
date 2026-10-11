import { liveCollection } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { z } from "zod";
import {
  TaskListItemSchema,
  PushSchema,
  ConversationSchema,
} from "./internal/schema";
import { AttemptWithConversationsSchema } from "./schemas";

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
// Every task — the WHOLE ordered set (`all`): the task list, the dependency
// graph and every per-task chip read a value for every task (a status, the
// dependency edges), so its readers hold the set entire. Served over the base
// tables and the attempt rollups (`../server/internal/task-rows.ts`): a task
// write is its own row's refill, an attempt / conversation / push write its
// task's, an edge write the edge's task and its dependents (the blocking
// closure), an insert an entrant, a delete an exit — never a whole-set reload.
// Ordered as the old list was: `rank`, then `createdAt` (the id breaks ties).
//
// The wire row is EXACTLY `TaskListItem` — every `tasks_v` column but the
// heavy `description` (read per task from `taskDescriptions` below) — under
// the legacy key `tasks`: a tab still running a bundle that declared `tasks`
// as an old param-less keyed descriptor over `TaskListItemSchema` subscribes
// `{}`, passes the `all` gate and parses these rows with its own
// (identical) schema — the C39 old-bundle check, pinned by
// `../server/internal/tree-oracle.test.ts`. A change to the row must rename
// the key.
//
// Boot-critical (`preload: "boot"`): the task list paints from the boot
// snapshot. Named `taskRows` because `tasks` is the server's view handle.
export const taskRows = liveCollection("tasks", {
  row: TaskListItemSchema,
  id: "id",
  all: {
    orderBy: [
      ["rank", "asc"],
      ["createdAt", "asc"],
    ],
    unbounded: {
      reason:
        "the task list, the dependency graph and the task chips need every task's status and dependency edges",
    },
  },
  preload: "boot",
});

// One task's `description` — the heavy text the `tasks` set leaves out — read
// by id (`useLiveRow(taskDescriptions, id)`): lookup-only, so it loads only
// for an open detail pane, and a description autosave is that one row's
// refill. A task the read does not find is `found: false`. Served over the
// `tasks` table in `../server/internal/resources.ts`.
export const taskDescriptions = liveCollection("task-descriptions", {
  row: z.object({ id: z.string(), description: z.string().nullable() }),
  id: "id",
});
// Every attempt — the WHOLE ordered set (`all`), each with its non-system
// conversations (`ConversationSummary`, oldest first): the attempt pane, the
// attempt chips, the task's attempt and run lists (`../web/hooks.ts`) and the
// worktree's linked task each read a value for every attempt. Served over the
// `attempts` table, its two rollups and a children `jsonAgg` of its
// conversations (`../server/internal/attempt-rows.ts`), never `attempts_v`:
// an attempt write is its own row's refill, a conversation write its
// attempt's (gated: `waiting_for` / `last_viewed_at` / `updated_at` reach
// nothing), a push its attempt's, an insert an entrant, a delete an exit —
// never a whole-set reload. Ordered as the old list was: `createdAt` (the id
// breaks ties).
//
// The wire row is EXACTLY `AttemptWithConversations`, under the legacy key
// `attempts`: a tab still running a bundle that declared `attempts` as an old
// param-less keyed descriptor subscribes `{}`, passes the `all`
// gate and parses these rows with its own (identical) schema — the C39
// old-bundle check, pinned by `../server/internal/tree-oracle.test.ts`. A
// change to the row must rename the key.
//
// Boot-critical (`preload: "boot"`). Named `attemptRows` because `attempts`
// is the server's view handle.
export const attemptRows = liveCollection("attempts", {
  row: AttemptWithConversationsSchema,
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    unbounded: {
      reason:
        "the attempt pane, the attempt chips, the task's attempt and run lists and the worktree's linked task read every attempt's status and conversations",
    },
  },
  preload: "boot",
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
  row: PushSchema,
  id: "id",
  filterable: { attemptId: liveText() },
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
export const conversationsActive = liveCollection("conversations-active", {
  row: ConversationSchema,
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
  row: ConversationSchema,
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
// by a reader that wants more (Recovery reads 50). A `scroll` collection, so
// the queue's Done section pages through the whole history as the user
// scrolls (`useLive` with a viewport: its first page IS the default window). A close
// is an entrant at the top, a restore an exit; it is not L2-persisted (a
// bounded window leaves L2). Nothing filters it (`filterable: {}`).
// Boot-critical: the default window paints from the boot snapshot. Counted
// (`count: true`): `useLive(conversationsGone, { count: true })` is how many
// conversations have ended in all — the welcome counts, and the Done
// section's exact count — preloaded with the window, one COUNT per write.
export const conversationsGone = liveCollection("conversations-gone", {
  row: ConversationSchema,
  id: "id",
  filterable: {},
  sortable: ["endedAt"],
  default: { orderBy: [["endedAt", "desc"]], limit: RECENT_GONE_LIMIT },
  maxLimit: 500,
  scroll: true,
  count: true,
  preload: "boot",
});
// One conversation by id, whatever its status or age (`useLiveRow`): the
// conversation pane, every toolbar control and chip that holds an id. A point
// read, so a done conversation older than the newest `RECENT_GONE_LIMIT` is
// found like any other (W9) — no REST fallback. Lookup-only (`:rows` alone,
// never preloaded); a write to row R reaches only the tuples holding R.
export const conversationsById = liveCollection("conversations.by-id", {
  row: ConversationSchema,
  id: "id",
});
