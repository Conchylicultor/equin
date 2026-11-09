import { dirname, isAbsolute, normalize } from "node:path";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import {
  createRefcountHub,
  type HubHold,
} from "@plugins/packages/plugins/refcount-hub/core";
import { WatchedDirGoneError, type WatchReaction } from "../../shared/engine";
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
  /**
   * The changes in scope, batched. Never called with an empty batch. Return
   * the work's promise: one call runs at a time for this watcher, and the
   * batches landing meanwhile fold into one trailing call.
   */
  onChange: WatchReaction<FileChangeEvent>;
  /**
   * The native watch this one rides errored and may have dropped events —
   * anything in scope may have changed unheard. Every watcher riding that
   * watch hears it, whatever its dir and scope. The error is already logged.
   */
  onLost?: (error: unknown) => void;
}

/** Give a watch back; the last one on a root stops its native watch. */
export type DirWatchRelease = () => void;

export interface DirWatchHub {
  /**
   * Watch `dir` until the returned release runs. Resolves once the native
   * watch is open; rejects when it cannot be opened (a missing dir), holding
   * nothing. The watch is live then, whatever its scope: a change landing
   * after it resolves is heard (a `children` watch off macOS excepted — see
   * the engine's `depth: "children"`).
   */
  acquire(request: DirWatchRequest): Promise<DirWatchRelease>;
  /** The roots with a native recursive watch open, or opening (a retired one is not). */
  roots(): string[];
  /** The dirs with a native single-directory watch open, or opening. */
  shallowDirs(): string[];
}

/**
 * Opens one native watch on `root`, batching its changes — recursive
 * (`subtree`), or of its direct entries only (`children`).
 */
export type StartRootWatch = (
  root: string,
  onChange: (events: FileChangeEvent[]) => void,
  onLost: (error: unknown) => void,
) => Promise<{ stop(): Promise<void> }>;

/** What one native watch tells its riders: a batch, or that events were lost. */
type RootSignal =
  | { kind: "changes"; events: FileChangeEvent[] }
  | { kind: "lost"; error: unknown };

/** The two native watches the hub opens. */
export interface DirWatchStarts {
  /** A recursive watch: a root other watchers below it may ride. */
  subtree: StartRootWatch;
  /** A single-directory watch: what a `children` request opens on its own. */
  children: StartRootWatch;
}

function isUnder(dir: string, path: string): boolean {
  return dir === "/" ? path.startsWith("/") : path.startsWith(`${dir}/`);
}

function inScope(dir: string, scope: DirWatchScope, path: string): boolean {
  if (path === dir) return true;
  return scope === "children" ? dirname(path) === dir : isUnder(dir, path);
}

/**
 * One native watch per dir at a time, keyed `${dir}\0${generation}`. A watch
 * that reports its own dir gone is dead — it hears nothing more of whatever
 * folder lands at that path — so it is retired: the dir forgets its key, and
 * the next acquire there opens a fresh watch under a new key rather than
 * joining the dead one (which the holders still riding it keep until they
 * release).
 */
function createGenerations(isOpen: (key: string) => boolean) {
  const current = new Map<string, string>();
  let generation = 0;
  return {
    /** The dir's live key, minting one when it has none (or a stale one). */
    keyFor(dir: string): string {
      let key = current.get(dir);
      if (key === undefined || !isOpen(key)) {
        key = `${dir}\0${++generation}`;
        current.set(dir, key);
      }
      return key;
    },
    /** The dir's live key, if a watch of it is open (or opening) and not dead. */
    liveKey(dir: string): string | undefined {
      const key = current.get(dir);
      return key !== undefined && isOpen(key) ? key : undefined;
    },
    isLive: (key: string): boolean => current.get(dirOf(key)) === key,
    retire(key: string): void {
      if (current.get(dirOf(key)) === key) current.delete(dirOf(key));
    },
  };
}

const dirOf = (key: string): string => key.slice(0, key.indexOf("\0"));

/** One watcher, and the root whose native watch it currently rides. */
interface Holder {
  dir: string;
  root: string;
  /** `root`'s generation key — the native watch it rides. */
  rootKey: string;
  hold: HubHold;
  /** The dead root's hold it is leaving, kept until the new root's watch is open. */
  previous: HubHold | null;
  /** Its own filtered listener — re-attached as is when it moves roots. */
  listener: (signal: RootSignal) => void;
  /** Set once its first hold is live; only a live holder is rescued. */
  live: boolean;
  released: boolean;
}

/**
 * The directory-watch hub: one native (recursive) watch per folder tree,
 * however many watchers want a dir inside it.
 *
 * An acquire for a dir that an open root already covers (the dir itself or an
 * ancestor of it) rides that root's watch, filtered to its own dir and scope;
 * any other `subtree` acquire opens a new root at the dir. A `children`
 * acquire never opens a recursive root: with no root above it, it shares a
 * single-directory watch of its dir (refcounted per dir), so listing `~` or
 * `/` holds one directory handle, not a watch of everything below it. Such a
 * watch is never a root (nothing rides it) and never moves: a recursive root
 * opening above it later leaves it where it is.
 *
 * **A live watcher never moves either.** A root opening ABOVE roots already
 * open (a checkout watch after a child listing) leaves their watchers where
 * they are: the lower root keeps its native watch until its last watcher
 * releases, and later acquires below it ride the nearest root. Moving them
 * up would release the lower native watch, and closing an FSEvents stream
 * drops what fseventsd has queued for it and not delivered yet — seconds
 * while it is loaded (2026-11-09) — so a change made just before the move
 * went unheard. On macOS the engine's stream pool already shares one stream
 * per watched root across the process (`fsevents-pool.ts`, where riders never
 * move for the same reason); here the cost is one more native watch of the
 * lower tree for as long as it is held (on Linux, its inotify descriptors).
 * A root stops when its last watcher releases.
 *
 * A root whose own dir goes (removed, moved, replaced — the engine's
 * {@link WatchedDirGoneError}) is retired: its riders hear `onLost`, a later
 * acquire of that dir (or one under it) opens a fresh root, and the riders
 * stranded on the dead one move onto a live root already covering it, else
 * onto whichever root next opens or is acquired at or above it — a dead watch
 * hears nothing, so there is nothing queued to lose. The
 * release an acquire returns follows its watcher onto whichever root it rides.
 */
export function createDirWatchHub(starts: DirWatchStarts): DirWatchHub {
  const hub = createRefcountHub<RootSignal>(async (key, emit) => {
    const root = dirOf(key);
    const watch = await starts.subtree(
      root,
      (events) => emit({ kind: "changes", events }),
      (error) => {
        const dead = error instanceof WatchedDirGoneError && error.dir === root;
        if (dead) rootKeys.retire(key);
        emit({ kind: "lost", error });
        // Its riders move onto a live root covering it, if one is open: no
        // acquire may ever open a root at that root's own dir again.
        if (dead && root !== "/") {
          const above = coveringRoot(dirname(root));
          if (above !== undefined) rescueStranded(above);
        }
      },
    );
    return () => {
      rootKeys.retire(key);
      return watch.stop();
    };
  });
  const rootKeys = createGenerations((key) => hub.has(key));
  // A single-directory watch reports its dir gone as a delete of the dir (or
  // the watch failed) — retired then, so the holder re-arming on that delete
  // opens a fresh watch (its previous hold, released only once the new one is
  // open, still keeps the dead one).
  const shallow = createRefcountHub<RootSignal>(async (key, emit) => {
    const dir = dirOf(key);
    const watch = await starts.children(
      dir,
      (events) => {
        const gone = events.some((e) => e.type === "delete" && e.path === dir);
        if (gone) shallowKeys.retire(key);
        emit({ kind: "changes", events });
      },
      (error) => emit({ kind: "lost", error }),
    );
    return () => {
      shallowKeys.retire(key);
      return watch.stop();
    };
  });
  const shallowKeys = createGenerations((key) => shallow.has(key));
  const holders = new Set<Holder>();

  /** The nearest open (or opening), not dead, root at or above `dir`. */
  function coveringRoot(dir: string): string | undefined {
    for (let d = dir; ; d = dirname(d)) {
      if (rootKeys.liveKey(d) !== undefined) return d;
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
    const oldKey = h.rootKey;
    const key = rootKeys.keyFor(root);
    const next = hub.acquire(key, h.listener);
    h.previous?.release();
    h.previous = old;
    h.hold = next;
    h.root = root;
    h.rootKey = key;
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
        h.rootKey = oldKey;
        h.previous = null;
      },
    );
  }

  /**
   * Gather onto `root` every watcher stranded on a dead root at or below it
   * (its dir went, and came back or is covered again). Runs once `root` is
   * live, so each re-attach joins an open watch. A watcher on a LIVE root
   * stays (see the hub's doc).
   */
  function rescueStranded(root: string): void {
    const key = rootKeys.liveKey(root);
    if (key === undefined) return;
    for (const h of holders) {
      if (!h.live || h.released || h.rootKey === key) continue;
      if (rootKeys.isLive(h.rootKey)) continue;
      if (h.root === root || isUnder(root, h.root)) move(h, root);
    }
  }

  return {
    async acquire({ dir, scope, onChange, onLost }) {
      const trailingSlash = dir.endsWith("/") && dir !== "/";
      if (!isAbsolute(dir) || normalize(dir) !== dir || trailingSlash) {
        throw new Error(
          `[file-watcher] a dir watch needs an absolute, normalized dir: ${dir}`,
        );
      }
      const covering = coveringRoot(dir);
      let released = false;
      // This watcher's own reaction queue: the native fan-out stays
      // synchronous, while a slow reaction holds only its own later batches.
      const reaction = createCoalescer<FileChangeEvent>({
        run: (events) => (released ? undefined : onChange(events)),
      });
      const listener = (signal: RootSignal) => {
        if (signal.kind === "lost") {
          if (!released) onLost?.(signal.error);
          return;
        }
        const mine = signal.events.filter((e) => inScope(dir, scope, e.path));
        if (mine.length > 0) reaction.trigger(mine);
      };
      if (scope === "children" && covering === undefined) {
        const hold = shallow.acquire(shallowKeys.keyFor(dir), listener);
        await hold.ready;
        return () => {
          if (released) return;
          released = true;
          hold.release();
        };
      }
      const root = covering ?? dir;
      const rootKey = rootKeys.keyFor(root);
      const h: Holder = {
        dir,
        root,
        rootKey,
        hold: hub.acquire(rootKey, listener),
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
      // Take in the watchers stranded on a dead root below the one this rides.
      rescueStranded(h.root);
      return () => {
        if (h.released) return;
        h.released = true;
        released = true;
        holders.delete(h);
        h.hold.release();
        h.previous?.release();
        h.previous = null;
      };
    },
    roots: () => hub.keys().filter(rootKeys.isLive).map(dirOf),
    shallowDirs: () => shallow.keys().map(dirOf),
  };
}
