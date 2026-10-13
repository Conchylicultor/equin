import type {
  DirWatchRelease,
  DirWatchRequest,
  FileChangeEvent,
  WatchReaction,
} from "@plugins/infra/plugins/file-watcher/server";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
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
  /**
   * The ref a `git` change writes (`refs/heads/main`), when it is one. A
   * reader only hears the refs it asked for (see {@link CheckoutRefs}).
   */
  ref?: string;
}

/**
 * Which refs a reader's state reads, beside HEAD, the index and the working
 * tree. The refs dir is SHARED by every worktree of the repo, so a reader that
 * heard all of it would recompute on every other worktree's commit.
 *
 * The checkout's own branch (HEAD's target, followed across a checkout) is
 * always heard.
 */
export interface CheckoutRefs {
  /** Full ref names read besides the own branch (`refs/heads/main`). */
  also: readonly string[];
  /** Also the own branch's upstream (an ahead/behind count reads it). */
  upstream?: boolean;
}

export interface CheckoutWatchRequest {
  refs: CheckoutRefs;
  /**
   * The changes, batched; never an empty batch. Return the work's promise: one
   * call runs at a time for this reader, and batches landing meanwhile fold
   * into one trailing call.
   */
  onChange: WatchReaction<CheckoutChange>;
}

/** Give a checkout watch back; the checkout's last one stops it. */
export type CheckoutWatchRelease = () => void;

/** Where a checkout keeps its git state. */
export interface CheckoutLocation {
  /** Its own git dir: HEAD, the index (`<root>/.git`, or `<common>/worktrees/<name>`). */
  gitDir: string;
  /** The repo's common dir, holding the refs every worktree shares. */
  commonDir: string;
}

/** The branch a checkout is on; `own` is null on a detached HEAD. */
export interface CheckoutBranch {
  own: string | null;
  upstream: string | null;
}

export interface CheckoutWatchDeps {
  locate: (root: string) => Promise<CheckoutLocation>;
  /** HEAD's target and its upstream, read now. */
  readBranch: (root: string) => Promise<CheckoutBranch>;
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
 * The ref a path under the common dir writes (`refs/heads/x`, from the ref
 * file or its `.lock`), or undefined when it is not a loose ref.
 */
export function refAt(commonDir: string, path: string): string | undefined {
  const rel = relativeTo(commonDir, path);
  if (rel === null || !rel.startsWith("refs/")) return undefined;
  return rel.endsWith(".lock") ? rel.slice(0, -".lock".length) : rel;
}

/** Whether a reader asking for `refs` hears `change`, on `branch`. */
export function hears(
  refs: CheckoutRefs,
  branch: CheckoutBranch,
  change: CheckoutChange,
): boolean {
  const { ref } = change;
  if (ref === undefined) return true;
  if (ref === branch.own) return true;
  if (refs.upstream === true && ref === branch.upstream) return true;
  return refs.also.includes(ref);
}

/** The branch stand-in while it cannot be read: every ref is heard. */
const ALL_REFS: CheckoutBranch = Object.freeze({ own: null, upstream: null });

/** One delivery to every reader: the kept changes, and the branch then. */
interface Delivery {
  changes: CheckoutChange[];
  branch: CheckoutBranch;
}

/**
 * The checkout watch hub: one watch per checkout root, however many readers
 * want it, over the directory-watch hub (so a linked worktree's git dirs ride
 * the main checkout's watch when that one is open too).
 */
export function createCheckoutWatchHub(deps: CheckoutWatchDeps) {
  const hub = createRefcountHub<Delivery>(async (root, emit) => {
    const { gitDir, commonDir } = await deps.locate(root);
    const inside = (dir: string) => relativeTo(root, dir) !== null;
    const outside = [gitDir, `${commonDir}/refs`].filter((d) => !inside(d));
    let branch = await deps.readBranch(root);
    const headFiles = new Set([`${gitDir}/HEAD`, `${gitDir}/HEAD.lock`]);

    // Batches in order, one delivery at a time: a batch that moves HEAD
    // re-reads the branch BEFORE it (and anything queued behind it) is
    // filtered, so `git checkout b` plus the write to `refs/heads/b` is judged
    // against the new branch.
    const deliver = createCoalescer<CheckoutChange>({
      run: (changes) => {
        // Synchronous unless HEAD moved: a plain batch reaches the readers in
        // the same turn, and never waits behind a microtask.
        if (!changes.some((c) => headFiles.has(c.path))) {
          emit({ changes, branch });
          return undefined;
        }
        return rereadThenEmit(changes);
      },
    });
    async function rereadThenEmit(changes: CheckoutChange[]): Promise<void> {
      try {
        branch = await deps.readBranch(root);
      } catch (err) {
        // Unknown branch: every reader hears every ref until a later HEAD
        // change reads it again — then fail loudly.
        branch = ALL_REFS;
        emit({ changes, branch });
        throw err;
      }
      emit({ changes, branch });
    }
    const forward = (changes: (CheckoutChange | null)[]): void => {
      const kept: CheckoutChange[] = [];
      for (const c of changes) {
        if (c === null) continue;
        const ref = c.area === "git" ? refAt(commonDir, c.path) : undefined;
        kept.push(ref === undefined ? c : { ...c, ref });
      }
      if (kept.length > 0) deliver.trigger(kept);
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
      for (const dir of outside) {
        releases.push(
          await deps.acquireDirWatch({
            dir,
            scope: "subtree",
            onChange: (events) =>
              forward(events.map((e) => classifyGitDirEvent(dir, e))),
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
      request: CheckoutWatchRequest,
    ): Promise<CheckoutWatchRelease> {
      let released = false;
      // This reader's own reaction queue: a slow reader holds only its own
      // later batches, never the hub or another reader.
      const reaction = createCoalescer<CheckoutChange>({
        run: (changes) => (released ? undefined : request.onChange(changes)),
      });
      const hold = hub.acquire(root, ({ changes, branch }) => {
        const mine =
          branch === ALL_REFS
            ? changes
            : changes.filter((c) => hears(request.refs, branch, c));
        if (mine.length > 0) reaction.trigger(mine);
      });
      await hold.ready;
      return () => {
        released = true;
        hold.release();
      };
    },
    /** The checkouts watched, or being opened. */
    roots: () => hub.keys(),
  };
}
