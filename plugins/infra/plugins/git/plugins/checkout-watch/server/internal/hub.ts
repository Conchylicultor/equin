import type {
  DirWatchRelease,
  DirWatchRequest,
  FileChangeEvent,
} from "@plugins/infra/plugins/file-watcher/server";
import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";

/** One change that can move a checkout's state. */
export interface CheckoutChange {
  /** Absolute. */
  path: string;
  type: FileChangeEvent["type"];
  /**
   * `"worktree"` — a file of the working tree; `"git"` — the checkout's git
   * dir (HEAD, the index, a ref), wherever it lives.
   */
  area: "worktree" | "git";
}

/** Give a checkout watch back; the checkout's last one stops it. */
export type CheckoutWatchRelease = () => void;

export interface CheckoutWatchDeps {
  /** The git dirs a checkout keeps outside its root (a linked worktree's). */
  gitDirsOutside: (root: string) => Promise<string[]>;
  acquireDirWatch: (request: DirWatchRequest) => Promise<DirWatchRelease>;
}

/** `abs` relative to `dir`, or null when it is not inside it. */
function relativeTo(dir: string, abs: string): string | null {
  if (abs === dir) return "";
  const prefix = dir === "/" ? "/" : `${dir}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

/**
 * Inside a git dir, what never moves the checkout: object writes (they always
 * come with an index or ref change), reflogs, and other worktrees' git dirs.
 */
const GIT_DIR_NOISE = ["objects", "logs", "worktrees"];

function isGitNoise(relInGitDir: string): boolean {
  const top = relInGitDir.split("/", 1)[0]!;
  return GIT_DIR_NOISE.includes(top);
}

/**
 * The change an event under the checkout's root is, or null when it cannot
 * move the checkout: git-dir noise, or anything in a `node_modules` (installs
 * write tens of thousands of files no checkout reader looks at).
 */
export function classifyRootEvent(
  root: string,
  event: FileChangeEvent,
): CheckoutChange | null {
  const rel = relativeTo(root, event.path);
  if (rel === null) return null;
  if (rel === ".git" || rel.startsWith(".git/")) {
    const inGit = rel === ".git" ? "" : rel.slice(".git/".length);
    if (isGitNoise(inGit)) return null;
    return { path: event.path, type: event.type, area: "git" };
  }
  if (rel.split("/").includes("node_modules")) return null;
  return { path: event.path, type: event.type, area: "worktree" };
}

/** The change an event under a git dir outside the root is, or null for noise. */
export function classifyGitDirEvent(
  gitDir: string,
  event: FileChangeEvent,
): CheckoutChange | null {
  const rel = relativeTo(gitDir, event.path);
  if (rel === null || isGitNoise(rel)) return null;
  return { path: event.path, type: event.type, area: "git" };
}

/**
 * The checkout watch hub: one watch per checkout root, however many readers
 * want it, over the directory-watch hub (so a linked worktree's git dirs ride
 * the main checkout's watch when that one is open too).
 */
export function createCheckoutWatchHub(deps: CheckoutWatchDeps) {
  const hub = createRefcountHub<CheckoutChange[]>(async (root, emit) => {
    const outside = await deps.gitDirsOutside(root);
    const forward = (changes: (CheckoutChange | null)[]): void => {
      const kept = changes.filter((c): c is CheckoutChange => c !== null);
      if (kept.length > 0) emit(kept);
    };
    const releases: DirWatchRelease[] = [];
    const releaseAll = (): void => {
      for (const release of releases) release();
    };
    try {
      releases.push(
        await deps.acquireDirWatch({
          dir: root,
          scope: "subtree",
          onChange: (events) =>
            forward(events.map((e) => classifyRootEvent(root, e))),
        }),
      );
      for (const gitDir of outside) {
        releases.push(
          await deps.acquireDirWatch({
            dir: gitDir,
            scope: "subtree",
            onChange: (events) =>
              forward(events.map((e) => classifyGitDirEvent(gitDir, e))),
          }),
        );
      }
    } catch (err) {
      releaseAll();
      throw err;
    }
    return releaseAll;
  });

  return {
    /**
     * Hear `root`'s changes until the returned release runs. Resolves once
     * the watch is live; rejects when it cannot be opened.
     */
    async acquire(
      root: string,
      onChange: (changes: CheckoutChange[]) => void,
    ): Promise<CheckoutWatchRelease> {
      const hold = hub.acquire(root, onChange);
      await hold.ready;
      return hold.release;
    },
    /** The checkouts watched, or being opened. */
    roots: () => hub.keys(),
  };
}
