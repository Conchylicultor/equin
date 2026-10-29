import { isAbsolute } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getAttemptRow } from "@plugins/tasks/plugins/tasks-core/server";
import {
  hasCapability,
  type WorkspaceKind,
} from "@plugins/conversations/plugins/workspace/core";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { resolveCheckoutRoot } from "./checkout-root";

export const MAIN_WORKTREE = "main";
// The current running server's own worktree root. Distinct from MAIN_WORKTREE,
// which resolves to the main checkout even when serving from a worktree.
export const SELF_WORKTREE = "self";

/** A workspace's root on disk, and whether it is a git checkout. */
export type WorkspaceRoot = { path: string; git: boolean };

/** What an attempt row says of its workspace's root: its checkout path and kind. */
export interface WorkspaceAttempt {
  worktreePath: string;
  workspace: { kind: WorkspaceKind };
}

/**
 * The attempt a workspace identifier names, as an id set: none for the
 * `"main"` / `"self"` sentinels and an absolute path, else `[id]` — the
 * tuple a live value follows `attemptWorkspaces` by (`{ ids }`), so a
 * sentinel's tuple reads no row and no write reaches it.
 */
export function workspaceAttemptIds(id: string): string[] {
  if (id === MAIN_WORKTREE || id === SELF_WORKTREE || isAbsolute(id)) return [];
  return [id];
}

// Resolve a workspace identifier (from the URL) to its root on disk, given the
// attempt row it names (`workspaceAttemptIds` — none for a sentinel or a
// path; an absent row is no workspace). `"main"`/`"self"` are reserved
// sentinels; an absolute path (URL-encoded in `:worktree`) is accepted only
// when it is exactly a git checkout's toplevel — so any checkout on the host
// (`~/code/foo`) is addressable, and every read under it stays a relative path
// inside that root. Any other value is an attempt id, whatever its workspace
// kind. Pure over the row: a live value hands it the rows it follows.
export async function workspaceRootFrom(
  id: string,
  attempts: readonly WorkspaceAttempt[],
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
  if (attempts.length > 1) {
    throw new Error(
      `workspace ${id}: ${attempts.length} attempt rows for one id`,
    );
  }
  const attempt = attempts[0];
  if (attempt === undefined) return null;
  return {
    path: attempt.worktreePath,
    git: hasCapability(attempt.workspace.kind, "git"),
  };
}

/**
 * {@link workspaceRootFrom}, reading the attempt row itself (`_attempts`) —
 * for a caller outside a live value (the image route). A live value follows
 * `attemptWorkspaces` instead.
 */
export async function resolveWorkspaceRoot(
  id: string,
): Promise<WorkspaceRoot | null> {
  const attempts: WorkspaceAttempt[] = [];
  for (const attemptId of workspaceAttemptIds(id)) {
    const row = await getAttemptRow(attemptId);
    if (row !== null) attempts.push(row);
  }
  return workspaceRootFrom(id, attempts);
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
