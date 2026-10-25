import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// "Delete N safe": every row of the scan `at` names that is safe to delete
// (`isSafe`), read off the scan the panel holds — the safe set is the scan's,
// so the server takes it from there rather than from a list the panel would
// have to hold whole.
export const BulkDeleteWorktreesBodySchema = z.object({
  at: z.number().int(),
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
