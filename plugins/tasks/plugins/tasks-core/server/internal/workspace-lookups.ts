import { z } from "zod";
import { WorkspaceSpecSchema } from "@plugins/conversations/plugins/workspace/core";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import { compileLookup } from "@plugins/infra/plugins/query-resource/server";
import { _attempts, _conversations } from "./tables";

// Where an attempt — or a conversation, through its attempt — runs: its
// workspace's path and spec. Compiled lookups (query-resource's
// `compileLookup`), so a value loader that resolves its checkout through
// `run` declares exactly what that read reads (`read(keyOf)` in its
// `reads.lookups`): an `attempts` / `conversations` write reaches only the
// tuples asking about the row it touched, and only when it touched a column
// the lookup reads (`id`, `attempt_id`, `worktree_path`, `workspace`) — so a
// conversation's turn (its status) re-reads no edited-files page. Owned here,
// beside the tables; `conversations/workspace` cannot import tasks-core (a
// cycle: tasks-core's fields store its spec).

/** A workspace, as these lookups read it. */
const WorkspaceRowSchema = z.object({
  attemptId: z.string(),
  path: z.string(),
  spec: WorkspaceSpecSchema,
});

/** The workspace an attempt runs in, by the attempt's id. */
export const workspaceOfAttemptLookup = compileLookup({
  label: "tasks-core.workspace-of-attempt",
  from: _attempts,
  by: _attempts.id,
  select: {
    attemptId: { from: "base", col: _attempts.id },
    path: { from: "base", col: _attempts.worktreePath },
    spec: { from: "base", col: _attempts.workspace },
  },
  row: WorkspaceRowSchema,
});

/** The workspace a conversation runs in — its attempt's — by the conversation's id. */
export const workspaceOfConversationLookup = compileLookup({
  label: "tasks-core.workspace-of-conversation",
  from: _conversations,
  by: _conversations.id,
  joins: [
    {
      kind: "lookup",
      alias: "attempt",
      table: _attempts,
      pk: _attempts.id,
      on: { from: "base", col: _conversations.attemptId },
      // `conversations.attempt_id` is a NOT NULL cascade FK: never drops one.
      required: true,
    } satisfies LookupJoin<"attempt", typeof _attempts>,
  ],
  select: {
    attemptId: { from: "attempt", col: _attempts.id },
    path: { from: "attempt", col: _attempts.worktreePath },
    spec: { from: "attempt", col: _attempts.workspace },
  },
  row: WorkspaceRowSchema,
});
