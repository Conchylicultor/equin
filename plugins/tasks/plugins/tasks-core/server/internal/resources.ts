import { serveCollection } from "@plugins/network/plugins/live/server";
import { _attempts, _tasks, pushes } from "./tables";
import { attemptRowsServeOptions } from "./attempt-rows";
import { taskRowsServeOptions, taskWindowServeOptions } from "./task-rows";
import {
  conversationsActiveServeOptions,
  conversationsByIdServeOptions,
  conversationsGoneServeOptions,
  conversationsSystemServeOptions,
} from "./conversation-rows";
// Every resource here is declared in `../../core` (the single source of truth
// both runtimes read): each a `liveCollection` served with `serveCollection`,
// which reads key / schema / params off the declaration.
import {
  taskRows,
  taskClusterRows,
  taskWindow,
  taskDescriptions,
  attemptRows,
  attemptWorkspaces,
  pushRows,
  conversationsActive,
  conversationsSystem,
  conversationsGone,
  conversationsById,
} from "../../core";

// The conversation lists (`conversationsActive` / `conversationsSystem`: the
// whole ordered sets of live conversations; `conversationsGone`: the window of
// ended ones, newest first) and the by-id read (`conversationsById`,
// lookup-only) — every one over the `conversations` table with its owners
// joined (`./conversation-rows.ts`), never `conversations_v`. A conversation
// write refills its own row (a close is an exit from `active` and an entrant
// into `gone`'s window), an attempt or task write only the conversations it
// owns, through the owner joins' gated reverse routes — so a task hold or an
// attempt insert reaches no list (W4). No throttle (D16): the cascade the old
// 250 ms debounce protected (conversation → attempts → tasks) is gone, and a
// status batch now costs one-row refills.
export const conversationsActiveServed = serveCollection(
  conversationsActive,
  conversationsActiveServeOptions,
);
export const conversationsSystemServed = serveCollection(
  conversationsSystem,
  conversationsSystemServeOptions,
);
export const conversationsGoneServed = serveCollection(
  conversationsGone,
  conversationsGoneServeOptions,
);
export const conversationsByIdServed = serveCollection(
  conversationsById,
  conversationsByIdServeOptions,
);

// The `pushes` collection (declared in core as `pushRows`): its window —
// filterable by `attemptId`, newest first — and its `:rows` point sibling, over
// the `pushes` table (all seven columns are row fields, so every one is on the
// wire). A push change reaches each subscribed attempt window through window
// membership — at most one bounded ids query per tuple — and
// `pushes_attempt_id_idx` backs the per-attempt read.
export const pushRowsServed = serveCollection(pushRows, { from: pushes });

// One task's attempts with their non-system conversations (`attemptRows`, key
// `attempts.v2`, scoped by `taskId`) and its `:rows` point sibling — compiled
// from the `attempts` table, the two attempt rollups and a children `jsonAgg`
// of the attempt's conversations (`./attempt-rows.ts`), never `attempts_v`. A
// routed alias: an attempt write refills its own row, a conversation or
// push write its attempt's — through the conversation route's gate and the
// rollups' source routes, so a poller write (`waiting_for`,
// `last_viewed_at`) and a push reach no FULL reload (C1) — an insert is an
// entrant and a delete an exit.
export const attemptRowsServed = serveCollection(
  attemptRows,
  attemptRowsServeOptions,
);

// The tasks window (`taskRows`, `tasks.v2`, read by id through `:rows`) — compiled
// from the base tables and the attempt rollups (`./task-rows.ts`), never
// `tasks_v`. A routed alias: a task write refills its own row, an attempt /
// conversation / push write its task's, an edge write its task's and every
// dependent's.
//
// Preloaded at the tasks of the live conversations (`conversationsActive`'s
// `taskId`s, itself preloaded): the queue reads their statuses by exactly
// that id set, so it settles on its first render.
export const taskRowsServed = serveCollection(taskRows, {
  ...taskRowsServeOptions,
  preloadRows: { idsOf: conversationsActive, field: "taskId" },
});

// One cluster's tasks (`taskClusterRows`, scoped by `clusterId`) — the same
// binding as `taskRows`, so a row reads the same in both. A relabel (a union)
// is the loser cluster's rows leaving its tuple and entering the winner's.
export const taskClusterRowsServed = serveCollection(
  taskClusterRows,
  taskRowsServeOptions,
);

// The tasks tree (`taskWindow`, key `tasks.tree`): the stored aggregates
// (`./task-rows.ts`) are side tables on the change feed, so a status move
// anywhere in a task's closure is a write to its side row — one routed
// refill, and an entrant / exit of a window filtered on it. Every row's
// `$childCount` is the stored `task_child_count` (a filing, a move or a
// delete recounts the folders it left and joined).
export const taskWindowServed = serveCollection(
  taskWindow,
  taskWindowServeOptions,
);

// One attempt's workspace by id (`attemptWorkspaces`, lookup-only), over the
// `attempts` table.
export const attemptWorkspacesServed = serveCollection(attemptWorkspaces, {
  from: _attempts,
});

// One task's `description` by id (`taskDescriptions`, lookup-only: `:rows`
// alone), over the `tasks` table — a description autosave is that row's
// refill, and only an open detail pane reads it.
export const taskDescriptionsServed = serveCollection(taskDescriptions, {
  from: _tasks,
});
