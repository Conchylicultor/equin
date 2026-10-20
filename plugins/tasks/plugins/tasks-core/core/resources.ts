import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { z } from "zod";
import {
  AttemptStatusSchema,
  TASK_STATUS_OPTIONS,
  TaskStatusSchema,
} from "./internal/schema";
import { ConversationSummarySchema } from "./schemas";
import {
  attemptsEntityRef,
  conversationsEntityRef,
  pushesEntityRef,
  tasksEntityRef,
} from "./entity-refs";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
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
// Every task — the WHOLE ordered set (`all`): the task list, the dependency
// graph and every per-task chip read a value for every task (a status, the
// dependency edges), so its readers hold the set entire. Served over the base
// tables and the attempt rollups (`../server/internal/task-rows.ts`): a task
// write is its own row's refill, an attempt / conversation / push write its
// task's, an edge write the edge's task and its dependents (the blocking
// closure), an insert an entrant, a delete an exit — never a whole-set reload.
// Ordered as the old list was: `rank`, then `createdAt` (the id breaks ties).
//
// Declared by FIELDS over the `tasks` entity (`from: tasksEntityRef`): the
// task list's fields — the title and last update (`pick`), the derived
// `status` (an own field, bound by `../server/internal/task-rows.ts`) — carry
// their labels, types and options, so no list builds them; and every field a
// task extension exposes (its track, category, automation origin) folds into
// each row under `$columns` (the base exposures), filtered and grouped in
// memory with no list code. Each is a rarely-written side table (a track
// switch, a filing, a categorisation — unlike a conversation's usage), so
// folding them into this boot-preloaded set stays cheap.
//
// The wire row is `TaskListItem` — every `tasks_v` column but the heavy
// `description` (read per task from `taskDescriptions` below) — plus the
// additive `$columns`, under the legacy key `tasks`: a tab still running a
// bundle that declared `tasks` as an old param-less keyed descriptor over
// `TaskListItemSchema` subscribes `{}`, passes the `all` gate and parses these
// rows with its own schema, which strips the keys it does not know — the C39
// old-bundle check, pinned by `../server/internal/tree-oracle.test.ts`. A
// removed, renamed or retyped field must rename the key.
//
// Boot-critical (`preload: "boot"`): the task list paints from the boot
// snapshot. Named `taskRows` because `tasks` is the server's view handle.
export const taskRows = liveCollection("tasks", {
  from: tasksEntityRef,
  pick: ["title", "updatedAt"],
  fields: {
    status: enumTextField(TaskStatusSchema.options, {
      label: "Status",
      options: TASK_STATUS_OPTIONS,
    }),
  },
  carry: {
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
  },
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

/** A task as `taskRows` delivers it: a `TaskListItem` and its exposed fields under `$columns`. */
export type TaskRow =
  typeof taskRows extends LiveRowsCollection<infer R> ? R : never;

// One task's `description` — the heavy text the `tasks` set leaves out — read
// by id (`useLiveRow(taskDescriptions, id)`): lookup-only, so it loads only
// for an open detail pane, and a description autosave is that one row's
// refill. A task the read does not find is `found: false`. Served over the
// `tasks` table in `../server/internal/resources.ts`.
export const taskDescriptions = liveCollection("task-descriptions", {
  from: tasksEntityRef,
  carry: { pick: ["id", "description"] },
  baseExposures: false,
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
  from: attemptsEntityRef,
  // `workspace` is left off: the row is pinned by the C39 old-bundle check, so
  // the workspace crosses the wire on its own lookup (`attemptWorkspaces`).
  carry: {
    pick: ["id", "taskId", "worktreePath", "createdAt", "updatedAt"],
    fields: {
      status: parsedTextField(AttemptStatusSchema, { default: "pending" }),
      active: boolField(),
      retained: boolField(),
      finishedAt: nullable(dateField()),
      conversations: jsonField({
        schema: z.array(ConversationSummarySchema),
        default: [],
      }),
    },
  },
  baseExposures: false,
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
// One attempt's workspace (conversations/workspace: a worktree, or a scratch
// dir and its profile) by attempt id — lookup-only, read with
// `useLiveRow(attemptWorkspaces, attemptId)` by the surfaces that gate on
// what the workspace offers (the conversation pane's git surfaces). Its own
// key rather than a field of `attempts`, whose row C39 pins. Served over the
// `attempts` table in `../server/internal/resources.ts`; the column is written
// once, at insert.
export const attemptWorkspaces = liveCollection("attempt-workspaces", {
  from: attemptsEntityRef,
  carry: { pick: ["id", "workspace"] },
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
    "spawnedBy",
    "closeRequested",
    "hibernatedAt",
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
// One conversation by id, whatever its status or age (`useLiveRow`): the
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
