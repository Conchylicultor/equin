import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Single source of truth for a worktree row — shared by the server handler
// (return shape) and the web panel, which parses/validates each streamed NDJSON
// row with this schema rather than blindly JSON-parsing whatever the gateway returns.
export const WorktreeEntrySchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  taskStatus: z.string(),
  attemptStatus: z.string(),
  worktreePath: z.string(),
  createdAt: z.string(),
  dirExists: z.boolean(),
  dbExists: z.boolean(),
  isDirty: z.boolean(),
  isSafe: z.boolean(),
});
export type WorktreeEntry = z.infer<typeof WorktreeEntrySchema>;

// Streamed as NDJSON (no `response` schema) — see server/internal/handle-list.ts.
export const listWorktrees = defineEndpoint({
  route: "GET /api/debug/worktrees",
});

export const BulkDeleteWorktreesBodySchema = z.object({
  ids: z.array(z.string()),
});
export type BulkDeleteWorktreesBody = z.infer<
  typeof BulkDeleteWorktreesBodySchema
>;

export const bulkDeleteWorktrees = defineEndpoint({
  route: "POST /api/debug/worktrees/bulk-delete",
  body: BulkDeleteWorktreesBodySchema,
  response: z.object({
    succeeded: z.number(),
    failed: z.array(z.object({ id: z.string(), error: z.string() })),
  }),
});

export const deleteWorktree = defineEndpoint({
  route: "DELETE /api/debug/worktrees/:id",
});

// The reap sequence's steps, in the order they run, as ONE declaration both
// halves read: the server's `onStep` callback emits these, the panel labels
// these. It lives here because the two halves are in different runtimes and the
// union used to be spelled out in both — so adding the "namespaces" step meant
// remembering to widen a type in a file the change had no other reason to touch.
// With one list, a new step is a `tsc` error at the panel's label map until it is
// given something to say.
export const REAP_STEPS = [
  "worktree",
  "namespaces",
  "database",
  "config",
  "registry",
] as const;
export type ReapStep = (typeof REAP_STEPS)[number];
