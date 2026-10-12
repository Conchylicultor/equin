import { dirname, isAbsolute, normalize } from "node:path";
import {
  createRefcountHub,
  type HubHold,
} from "@plugins/packages/plugins/refcount-hub/core";
import type { FileChangeEvent } from "../../shared/registry";

/**
 * Which of a directory's changes a watcher hears.
 *
 * - `"subtree"` — every path at any depth below it (and the dir itself).
 * - `"children"` — only its direct entries (and the dir itself): what a
 *   depth-1 listing of it can show. A write deep inside a child folder moves
 *   no entry of the listing, so it is not reported.
 */
export type DirWatchScope = "subtree" | "children";

export interface DirWatchRequest {
  /** Absolute, normalized, as the filesystem reports it (no symlinked prefix). */
  dir: string;
  scope: DirWatchScope;
  /** The changes in scope, batched. Never called with an empty batch. */
  onChange: (events: FileChangeEvent[]) => void;
}

/** Give a watch back; the last one on a root stops its native watch. */
export type DirWatchRelease = () => void;

export interface DirWatchHub {
  /**
   * Watch `dir` until the returned release runs. Resolves once the watch is
   * live; rejects when it cannot be opened (a missing dir), holding nothing.
   */
  acquire(request: DirWatchRequest): Promise<DirWatchRelease>;
  /** The roots with a native watch open, or opening. */
  roots(): string[];
}

/** Opens one native recursive watch on `root`, batching its changes. */
export type StartRootWatch = (
  root: string,
  onChange: (events: FileChangeEvent[]) => void,
) => Promise<{ stop(): Promise<void> }>;

function isUnder(dir: string, path: string): boolean {
  return dir === "/" ? path.startsWith("/") : path.startsWith(`${dir}/`);
}

function inScope(dir: string, scope: DirWatchScope, path: string): boolean {
  if (path === dir) return true;
  return scope === "children" ? dirname(path) === dir : isUnder(dir, path);
}

/** One watcher, and the root whose native watch it currently rides. */
interface Holder {
  dir: string;
  root: string;
  hold: HubHold;
  /** The hold it is leaving, kept until the new root's watch is open. */
  previous: HubHold | null;
  /** Its own filtered listener — re-attached as is when it moves roots. */
  listener: (events: FileChangeEvent[]) => void;
  /** Set once its first hold is live; only a live holder moves. */
  live: boolean;
  released: boolean;
}

/**
 * The directory-watch hub: one native (recursive) watch per folder tree,
 * however many watchers want a dir inside it.
 *
 * An acquire for a dir that an open root already covers (the dir itself or an
 * ancestor of it) rides that root's watch, filtered to its own dir and scope;
 * any other opens a new root at the dir. When a root opens ABOVE roots already
 * open (a checkout watch after a child listing), it takes their watchers over:
 * each is re-attached to the new root, then its old hold is released once that
 * root is open, so the descendant's native watch stops and one tree never
 * holds two native watches for longer than the hand-over. A batch landing during that hand-over can be
 * heard twice (attach-before-release); none is lost. A root stops when its last
 * watcher releases. The release an acquire returns follows its watcher onto
 * whichever root it rides. A watcher whose own root went live after a root
 * above it opened moves up then, so the order the two opened in does not
 * matter.
 */
export function createDirWatchHub(start: StartRootWatch): DirWatchHub {
  const hub = createRefcountHub<FileChangeEvent[]>(async (root, emit) => {
    const watch = await start(root, emit);
    return () => watch.stop();
  });
  const holders = new Set<Holder>();

  /** The nearest open (or opening) root at or above `dir`. */
  function coveringRoot(dir: string): string | undefined {
    for (let d = dir; ; d = dirname(d)) {
      if (hub.has(d)) return d;
      if (d === dirname(d)) return undefined;
    }
  }

  /**
   * Re-attach `h` to `root`, and release its old hold once `root`'s watch is
   * open — never before, so the move opens no gap in what it hears. When that
   * open fails the watcher stays where it was (the failure is the root's
   * opener's to report: its acquire rejects).
   */
  function move(h: Holder, root: string): void {
    const old = h.hold;
    const oldRoot = h.root;
    const next = hub.acquire(root, h.listener);
    h.previous?.release();
    h.previous = old;
    h.hold = next;
    h.root = root;
    next.ready.then(
      () => {
        if (h.previous !== old) return;
        h.previous = null;
        old.release();
      },
      () => {
        if (h.released || h.hold !== next) return;
        h.hold = old;
        h.root = oldRoot;
        h.previous = null;
      },
    );
  }

  /**
   * Gather onto `root` every live watcher riding a root strictly below it.
   * Runs once `root` is live, so each re-attach joins an open watch.
   */
  function absorbBelow(root: string): void {
    if (!hub.has(root)) return;
    for (const h of holders) {
      if (h.live && !h.released && isUnder(root, h.root)) move(h, root);
    }
  }

  return {
    async acquire({ dir, scope, onChange }) {
      const trailingSlash = dir.endsWith("/") && dir !== "/";
      if (!isAbsolute(dir) || normalize(dir) !== dir || trailingSlash) {
        throw new Error(
          `[file-watcher] a dir watch needs an absolute, normalized dir: ${dir}`,
        );
      }
      const root = coveringRoot(dir) ?? dir;
      const listener = (events: FileChangeEvent[]) => {
        const mine = events.filter((e) => inScope(dir, scope, e.path));
        if (mine.length > 0) onChange(mine);
      };
      const h: Holder = {
        dir,
        root,
        hold: hub.acquire(root, listener),
        previous: null,
        listener,
        live: false,
        released: false,
      };
      holders.add(h);
      try {
        await h.hold.ready;
      } catch (err) {
        holders.delete(h);
        throw err;
      }
      h.live = true;
      // A root opened above this one while it was opening: ride that instead.
      const above = h.root === "/" ? undefined : coveringRoot(dirname(h.root));
      if (above !== undefined) move(h, above);
      // This acquire opened a root: take over the watchers below it.
      else if (h.root === dir) absorbBelow(dir);
      return () => {
        if (h.released) return;
        h.released = true;
        holders.delete(h);
        h.hold.release();
        h.previous?.release();
        h.previous = null;
      };
    },
    roots: () => hub.keys(),
  };
}
