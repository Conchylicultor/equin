import { isAbsolute } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getAttemptRow } from "@plugins/tasks/plugins/tasks-core/server";
import { hasCapability } from "@plugins/conversations/plugins/workspace/core";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { resolveCheckoutRoot } from "./checkout-root";

export const MAIN_WORKTREE = "main";
// The current running server's own worktree root. Distinct from MAIN_WORKTREE,
// which resolves to the main checkout even when serving from a worktree.
export const SELF_WORKTREE = "self";

/** A workspace's root on disk, and whether it is a git checkout. */
export type WorkspaceRoot = { path: string; git: boolean };

// Resolve a workspace identifier (from the URL) to its root on disk.
// `"main"`/`"self"` are reserved sentinels; an absolute path (URL-encoded in
// `:worktree`) is accepted only when it is exactly a git checkout's toplevel —
// so any checkout on the host (`~/code/foo`) is addressable, and every read
// under it stays a relative path inside that root. Any other value is looked
// up as an attempt id, whatever its workspace kind — a read of the attempt row
// (`_attempts`), which a live value serving through it declares.
export async function resolveWorkspaceRoot(
  id: string,
): Promise<WorkspaceRoot | null> {
  if (id === MAIN_WORKTREE) {
    return { path: await ensureMainWorktreeRoot(), git: true };
  }
  if (id === SELF_WORKTREE) {
    return { path: REPO_ROOT, git: true };
  }
  if (isAbsolute(id)) {
    const root = await resolveCheckoutRoot(id);
    return root === null ? null : { path: root, git: true };
  }
  const attempt = await getAttemptRow(id);
  if (!attempt) return null;
  return {
    path: attempt.worktreePath,
    git: hasCapability(attempt.workspace.kind, "git"),
  };
}

/**
 * The root of the workspace `id` names, for a read of its files as they are on
 * disk now — any workspace kind, a scratch dir included.
 */
export async function resolveWorkspacePath(id: string): Promise<string | null> {
  return (await resolveWorkspaceRoot(id))?.path ?? null;
}

/**
 * The root of the checkout `id` names, for a git read (a ref, a diff, a
 * commit range). A workspace that is not a checkout is a 400: asking it for
 * git is the caller's mistake, never an empty answer.
 */
export async function resolveWorktreePath(id: string): Promise<string | null> {
  const root = await resolveWorkspaceRoot(id);
  if (root === null) return null;
  if (!root.git) {
    throw new HttpError(400, `Workspace ${id} is not a git checkout`);
  }
  return root.path;
}
