import { isAbsolute } from "node:path";
import { getAttemptRow } from "@plugins/tasks/plugins/tasks-core/server";
import { assertCapability } from "@plugins/conversations/plugins/workspace/core";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { resolveCheckoutRoot } from "./checkout-root";

export const MAIN_WORKTREE = "main";
// The current running server's own worktree root. Distinct from MAIN_WORKTREE,
// which resolves to the main checkout even when serving from a worktree.
export const SELF_WORKTREE = "self";

// Resolve a worktree identifier (from the URL) to an absolute filesystem path.
// `"main"`/`"self"` are reserved sentinels; an absolute path (URL-encoded in
// `:worktree`) is accepted only when it is exactly a git checkout's toplevel —
// so any checkout on the host (`~/code/foo`) is addressable, and every read
// under it stays a relative path inside that root. Any other value is looked
// up as an attempt id.
export async function resolveWorktreePath(id: string): Promise<string | null> {
  if (id === MAIN_WORKTREE) {
    return await ensureMainWorktreeRoot();
  }
  if (id === SELF_WORKTREE) {
    return REPO_ROOT;
  }
  if (isAbsolute(id)) {
    return await resolveCheckoutRoot(id);
  }
  const attempt = await getAttemptRow(id);
  if (!attempt) return null;
  // Every /api/code/* read is a git one (tree, diff, commits); a scratch
  // workspace has no checkout to read, so asking is a caller bug.
  assertCapability(attempt.workspace.kind, "git", "code-explorer");
  return attempt.worktreePath;
}
