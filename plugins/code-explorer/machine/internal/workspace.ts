import { basename } from "node:path";
import { _attempts } from "@plugins/tasks/plugins/tasks-core/server";
import {
  acquireCheckoutWatch,
  type CheckoutChange,
} from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolveWorkspaceRoot,
  type WorkspaceRoot,
} from "../../server/internal/resolve-worktree-path";
import { isAllowedRef } from "../../server/internal/resolve-ref";

/**
 * What resolving a workspace id reads in Postgres: an attempt id resolves to
 * its attempt row's `worktreePath` (and workspace kind). A live value whose
 * loader resolves one declares it as its `reads`.
 */
export const workspaceRootReads = {
  tables: [_attempts],
  reason:
    "an attempt-id workspace resolves to its attempt row's worktree path and workspace kind before anything is read; the row appearing or going moves the answer between no-workspace and the workspace's files (a worktree path is set when the attempt is made and never rewritten)",
};

/**
 * The watches of a workspace whose root was not there when they opened (its
 * attempt row not written yet), waiting for a load to see it. Keyed by
 * workspace id.
 */
const rootWaiters = new Map<string, Set<(root: WorkspaceRoot) => void>>();

/**
 * The root of the workspace `id` names (reads {@link workspaceRootReads}) —
 * the one resolve every loader of this plugin's values runs. A root found
 * opens the watches {@link watchWorkspaceRoot} parked for it, so the load the
 * row's insert re-ran and the watch from then on read the same root.
 */
export async function loadWorkspaceRoot(
  id: string,
): Promise<WorkspaceRoot | null> {
  // Not named `root`: no-db-backed-notify matches names, not bindings, and
  // would read `watchCheckout`'s `root` parameter as this DB read
  // (task-1792544776-e7m6ec).
  const resolved = await resolveWorkspaceRoot(id);
  if (resolved !== null) {
    const waiting = rootWaiters.get(id);
    if (waiting !== undefined) {
      rootWaiters.delete(id);
      for (const open of waiting) open(resolved);
    }
  }
  return resolved;
}

/**
 * Open `open(root)` on the root of the workspace `id` names, until the
 * returned stop runs. A workspace with no root yet answers no-workspace; its
 * attempt row's insert re-runs the load ({@link workspaceRootReads}), whose
 * {@link loadWorkspaceRoot} opens the watch then — and `onChange` runs once
 * it is open, so a change between that load and the watch is not lost.
 */
export async function watchWorkspaceRoot(
  id: string,
  onChange: () => void,
  open: (root: WorkspaceRoot) => Promise<() => void>,
): Promise<() => void> {
  // Not named `root` (see loadWorkspaceRoot).
  const now = await resolveWorkspaceRoot(id);
  if (now !== null) return open(now);
  let stopped = false;
  let stop: () => void = noWatch;
  const arm = (found: WorkspaceRoot): void => {
    void open(found).then((opened) => {
      if (stopped) {
        opened();
        return;
      }
      stop = opened;
      onChange();
    });
  };
  let waiting = rootWaiters.get(id);
  if (waiting === undefined) rootWaiters.set(id, (waiting = new Set()));
  waiting.add(arm);
  return () => {
    stopped = true;
    const set = rootWaiters.get(id);
    set?.delete(arm);
    if (set?.size === 0) rootWaiters.delete(id);
    stop();
  };
}

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

/** {@link workspaceRootOf}, resolving `id` (reads {@link workspaceRootReads}). */
export async function resolveWorkspaceRootOf(
  id: string,
  refuse: RefuseWorkspace,
): Promise<string> {
  return workspaceRootOf(await loadWorkspaceRoot(id), id, refuse);
}

/** {@link checkoutRootOf}, resolving `id` (reads {@link workspaceRootReads}). */
export async function resolveCheckoutRootOf(
  id: string,
  refuse: RefuseWorkspace,
): Promise<string> {
  return checkoutRootOf(await loadWorkspaceRoot(id), id, refuse);
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
