import { basename } from "node:path";
import {
  acquireCheckoutWatch,
  type CheckoutChange,
} from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import { isAllowedRef } from "../../server/internal/resolve-ref";
import type { WorkspaceRoot } from "../../server/internal/resolve-worktree-path";

// Resolving a workspace id is a FOLLOW, never a hand read: a live value whose
// hooks need the root follows tasks-core's `attemptWorkspaces` by the id's
// attempt (`workspaceAttemptIds` — none for a sentinel or a path) and resolves
// it from the followed rows (`workspaceRootFrom`; both in
// `../../server/internal/resolve-worktree-path.ts`, re-exported by the machine
// barrel):
//
//   follows: (follow) => ({
//     ws: follow(attemptWorkspacesServed, ({ worktree }) => ({ ids: workspaceAttemptIds(worktree) })),
//   }),
//   loader: async (q, { followed }) => read(await workspaceRootFrom(q.worktree, followed.ws)),
//   whileFollowing: {
//     over: (followed) => followed.ws,
//     start: async (q, { over: ws, notify }) => watch(await workspaceRootFrom(q.worktree, ws), notify),
//   },
//
// So only a write to THAT attempt's workspace columns reaches the tuple, and a
// root that appears (the row inserted) or moves re-points the watch (the
// runtime's follow re-point), never a waiter parked beside it.

/** One file of a workspace, as a read names it — a workspace `FileRef`'s shape. */
export interface WorkspaceFile {
  workspace: string;
  path: string;
  /** Read as of this revision; absent: on disk now. */
  ref?: string;
}

/** The two refusals a workspace id can earn, whichever value refuses them. */
export type WorkspaceRefusal = "no-workspace" | "not-a-checkout";

/** A value's `refuse`, narrowed to what root resolution throws. */
export type RefuseWorkspace = (
  code: WorkspaceRefusal,
  message: string,
) => Error;

/** The root of the workspace `id` names (any kind), or its refusal. */
export function workspaceRootOf(
  root: WorkspaceRoot | null,
  id: string,
  refuse: RefuseWorkspace,
): string {
  if (root === null) throw refuse("no-workspace", `no workspace ${id}`);
  return root.path;
}

/** The root of the CHECKOUT `id` names — a git read needs one — or its refusal. */
export function checkoutRootOf(
  root: WorkspaceRoot | null,
  id: string,
  refuse: RefuseWorkspace,
): string {
  if (root === null) throw refuse("no-workspace", `no workspace ${id}`);
  if (!root.git) {
    throw refuse("not-a-checkout", `workspace ${id} is not a git checkout`);
  }
  return root.path;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Whether a read at these refs can never change: every one a sha (a commit
 * is addressed by its content), or one that is not a ref at all (the read is
 * refused, and a refusal does not heal while subscribed).
 */
export function pinnedRefs(refs: readonly string[]): boolean {
  return refs.every((ref) => SHA_RE.test(ref) || !isAllowedRef(ref));
}

/** The stop of a watch never opened: the tuple's answer cannot move, or is refused. */
export const noWatch = (): void => {};

/**
 * Hear the changes of the checkout at `root` that `hears` keeps, until the
 * returned stop runs: its working tree and its git dir (HEAD, the index, the
 * own branch — and `refs/heads/main` when a read resolves `main`, the
 * merge-base), over the shared checkout watch. A checkout that is gone has
 * nothing to watch: the loader says so.
 */
export async function watchCheckout(
  root: string,
  opts: { main: boolean; hears: (change: CheckoutChange) => boolean },
  onChange: () => void,
): Promise<() => void> {
  try {
    return await acquireCheckoutWatch(root, {
      refs: { also: opts.main ? ["refs/heads/main"] : [] },
      onChange: (changes) => {
        if (changes.some(opts.hears)) onChange();
      },
    });
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    return noWatch;
  }
}

/** A change to the checkout's git dir: HEAD, the index, a ref. */
export const gitDirChange = (change: CheckoutChange): boolean =>
  change.area === "git";

/** The index files of a git dir: rewritten by `git status`, `git diff`, `git add`. */
const INDEX_FILES = new Set(["index", "index.lock"]);

/**
 * A change to the checkout's git dir that can move what a ref names: HEAD or
 * a ref — not the index, which a read as of a ref (`ref:path`, `ls-tree`)
 * never consults, and which the commands agents run all the time rewrite.
 */
export const refChange = (change: CheckoutChange): boolean =>
  change.area === "git" &&
  (change.ref !== undefined || !INDEX_FILES.has(basename(change.path)));
