import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import {
  conversationOwnerColumns,
  conversationOwnerJoins,
} from "./conversation-owner";
import { _conversations } from "./tables";

// How the conversation collections (core: `conversationsActive`,
// `conversationsSystem`, `conversationsGone`, `conversationsById`) bind to the
// database — the ONE spelling both the served collections (`./resources.ts`)
// and the tests (`./tree-oracle.test.ts`, which compiles them against a
// throwaway database; `./all-parity.test.ts`, which holds the active set equal
// to `conversations_v`) read, so neither can drift from what ships.
//
// Each reads the `conversations` TABLE with its owners joined —
// `conversationOwnerJoins`, two REQUIRED (INNER) lookups: the attempt, then
// its task — never `conversations_v` (a routed compile reads base tables).
// Every row field but four binds to a column of `conversations` by name; the
// owners' `worktreePath` / `taskId` / `taskTitle` bind through
// `conversationOwnerColumns`, and `active` is `status <> 'done'` (the
// definition `conversations_v.active` spells). So a conversation write is its
// own row's refill (every column is a field, `waiting_for` included), an
// attempt write reaches the conversations of the attempt only through its
// reverse route, gated on `id` / `task_id` / `worktree_path`, and a task
// write only through its own, gated on `id` / `title` — a hold, a status
// flip, a drop or a reorder of a task, an attempt's insert, reach no
// conversation list (W4).

/** The row fields that are not columns of `conversations`. */
const columns = {
  ...conversationOwnerColumns,
  // Over any form's refs (the window's `JoinRefs`, the set's `AllJoinRefs`):
  // it reads only the base's `status`, rendered by the compile.
  active: (j: { base: { status: unknown } }) =>
    expr(sql`(${j.base.status} <> 'done')`, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
    }),
};

const owned = {
  from: _conversations,
  joins: conversationOwnerJoins,
  columns,
} as const;

/**
 * `conversations-active`: every live (not `done`) conversation but the
 * machine-spawned ones. A close is a where-flip exit, a resume an entrant.
 */
export const conversationsActiveServeOptions = {
  ...owned,
  where: and(
    ne(_conversations.status, "done"),
    ne(_conversations.kind, "system"),
  )!,
};

/** `conversations-system`: every live (not `done`) `system` conversation. */
export const conversationsSystemServeOptions = {
  ...owned,
  where: and(
    eq(_conversations.kind, "system"),
    ne(_conversations.status, "done"),
  )!,
};

/**
 * `conversations-gone`: every ended (`done`, with an `endedAt`) conversation
 * but the machine-spawned ones — the window's base membership, its order
 * `endedAt` (newest first by default).
 */
export const conversationsGoneServeOptions = {
  ...owned,
  where: and(
    eq(_conversations.status, "done"),
    isNotNull(_conversations.endedAt),
    ne(_conversations.kind, "system"),
  )!,
};

/** `conversations.by-id`: any conversation by id — no base membership. */
export const conversationsByIdServeOptions = owned;
