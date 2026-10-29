import { z } from "zod";
import { WorkspaceSpecSchema } from "@plugins/conversations/plugins/workspace/core";
import { compileLookup } from "@plugins/infra/plugins/query-resource/server";
import { _attempts } from "./tables";

// Where an attempt runs: its workspace's path and spec. A compiled lookup
// (query-resource's `compileLookup`), so a value loader that resolves its
// checkout through `run` declares exactly what that read reads (`read(keyOf)`
// in its `reads.lookups`): an `attempts` write reaches only the tuples asking
// about the row it touched, and only when it touched a column the lookup reads
// (`id`, `worktree_path`, `workspace`). A served value reading a
// CONVERSATION's workspace follows `conversationWorkspaces` instead
// (./follow-targets.ts). Owned here, beside the tables;
// `conversations/workspace` cannot import tasks-core (a cycle: tasks-core's
// fields store its spec).

/** A workspace, as the lookup reads it. */
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
