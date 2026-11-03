import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import {
  acquireDirWatch,
  type DirWatchRelease,
  type DirWatchRequest,
  type FileChangeEvent,
  type FileWatcherDecl,
  type WatchReaction,
} from "../../server";
import { WatchedDirGoneError } from "../../shared/engine";

type Acquire = (request: DirWatchRequest) => Promise<DirWatchRelease>;

/** A held watch of the dir itself, given back by its release. */
type InnerRelease = () => void | Promise<void>;

/** The reactions a dir's own watch reports to while it is held. */
interface InnerHooks {
  onChange: WatchReaction<FileChangeEvent>;
  onLost: (error: unknown) => void | Promise<unknown>;
}

interface FollowDirOptions {
  /** The dir to follow, as the filesystem reports it (no symlinked prefix). */
  dir: string;
  /** Opens the children watch of the dir's parent that hears it come and go. */
  watchParent: Acquire;
  /** Opens a watch of the dir itself; rejects when the dir is not there. */
  open: (hooks: InnerHooks) => Promise<InnerRelease>;
  /** The dir's changes, and its appearing and going as `create` / `delete` at `dir`. */
  onChange: WatchReaction<FileChangeEvent>;
  /**
   * A watch (the parent's or the dir's) may have dropped events, or the dir's
   * own watch saw it go. Coalesced: a burst is one call, with its last error.
   */
  onLost?: (error: unknown) => void | Promise<unknown>;
}

/** `path`'s inode when it is a directory, null when no directory is there. */
async function dirInode(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isDirectory() ? s.ino : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Follow a dir that may not exist yet, or may go and come back: a children
 * watch of its parent hears the dir appear, go or be replaced, and while it
 * is there a watch of the dir itself (`open`) is held. Its appearing and going
 * reach `onChange` as a `create` / `delete` event at `dir` — a replacement as
 * both — alongside the dir's own changes, through one reaction (one call at a
 * time). Resolves once the parent's watch (and the dir's, when it is there) is
 * open; rejects when the parent cannot be watched (it is missing), holding
 * nothing.
 *
 * The dir's own watch reporting its dir gone (`WatchedDirGoneError` — the
 * engine closed it) marks it dead and re-syncs: a folder re-created at the
 * path with the same inode (APFS reuses them) is watched again rather than
 * mistaken for the one the dead watch held.
 */
async function followDir(
  opts: FollowDirOptions,
): Promise<{ stop(): Promise<void> }> {
  const { dir, onChange } = opts;
  const name = basename(dir);
  let stopped = false;
  let inner: {
    ino: number;
    life: { gone: boolean };
    release: InnerRelease;
  } | null = null;
  // The first sync finds the dir as it is: nothing appeared or went yet.
  let synced = false;

  const reaction = createCoalescer<FileChangeEvent>({
    run: (events) => (stopped ? undefined : onChange(events)),
  });
  // Losses, from either watch, folded like changes (they come in bursts).
  const lost = createCoalescer<unknown>({
    run: (errors) =>
      stopped || opts.onLost === undefined
        ? undefined
        : opts.onLost(errors.at(-1)),
  });

  // Bring the held watch in line with what is at `dir` now. One run at a
  // time (a coalescer), so two parent batches never race two opens.
  const sync = createCoalescer({
    run: async () => {
      const first = !synced;
      synced = true;
      const ino = await dirInode(dir);
      if (
        stopped ||
        (inner !== null && !inner.life.gone && inner.ino === ino)
      ) {
        return;
      }
      if (inner === null && ino === null) return;
      const presence: FileChangeEvent[] = [];
      const report = (): void => {
        if (!first && presence.length > 0) reaction.trigger(presence);
      };
      if (inner !== null) {
        const held = inner;
        inner = null;
        presence.push({ type: "delete", path: dir });
        await held.release();
      }
      if (ino !== null) {
        const life = { gone: false };
        let release: InnerRelease;
        try {
          release = await opts.open({
            onChange: reaction.trigger,
            onLost: (error) => {
              if (error instanceof WatchedDirGoneError) {
                life.gone = true;
                sync.trigger();
              }
              return lost.run([error]);
            },
          });
        } catch (err) {
          // Gone again between the stat and the open: the parent's watch
          // hears it come back. Any other failure is real.
          if ((await dirInode(dir)) !== null) throw err;
          report();
          return;
        }
        if (stopped) {
          await release();
          return;
        }
        inner = { ino, life, release };
        presence.push({ type: "create", path: dir });
      }
      report();
    },
  });

  const outer = await opts.watchParent({
    dir: dirname(dir),
    scope: "children",
    onChange: (events) =>
      events.some((e) => basename(e.path) === name) ? sync.run() : undefined,
    onLost: (error) => {
      lost.trigger([error]);
      sync.trigger();
    },
  });
  try {
    await sync.run();
  } catch (err) {
    outer();
    throw err;
  }
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      outer();
      const held = inner;
      inner = null;
      await held?.release();
    },
  };
}

/** {@link acquireEventualDirWatch} over the hub `acquire` (a fake one in tests). */
export async function acquireEventualDirWatchWith(
  acquire: Acquire,
  request: DirWatchRequest,
): Promise<DirWatchRelease> {
  const followed = await followDir({
    dir: request.dir,
    watchParent: acquire,
    open: ({ onChange, onLost }) =>
      acquire({
        ...request,
        onChange,
        onLost: (error) => {
          // The hub's onLost takes no work back; a failed reaction is still
          // loud (an unhandled rejection).
          void onLost(error);
        },
      }),
    onChange: request.onChange,
    onLost: request.onLost,
  });
  // Hub releases are synchronous: stop() settles at once.
  return () => void followed.stop();
}

/**
 * `acquireDirWatch` for a dir that may not exist yet, or may be removed and
 * come back (a checkout whose path is recorded before it is created, and
 * reaped later). Holds a children watch of its PARENT, and a watch of the dir
 * while it is there; its appearing and going reach `onChange` as a `create` /
 * `delete` event at `dir` itself. Rejects only when the parent cannot be
 * watched.
 *
 * ```ts
 * whileSubscribed: async ({ path }, notify) =>
 *   acquireEventualDirWatch({ dir: path, scope: "children", onChange: () => notify() }),
 * ```
 */
export function acquireEventualDirWatch(
  request: DirWatchRequest,
): Promise<DirWatchRelease> {
  return acquireEventualDirWatchWith(acquireDirWatch, request);
}

export interface EventualFileWatcherOptions {
  /** The dir to follow, as the filesystem reports it (no symlinked prefix). */
  dir: string;
  /** How the catalog names the instance (see `FileWatcherStartOptions.label`). */
  label?: string;
  /**
   * The declared watcher's batches, plus the dir's appearing and going as a
   * `create` / `delete` event at `dir` itself (a replacement as both).
   */
  onChange: WatchReaction<FileChangeEvent>;
  /** A watch (the dir's, or its parent's) may have dropped events. */
  onLost?: (error: unknown) => void | Promise<unknown>;
}

/**
 * `decl.start` for a dir that may go and come back (a data dir a restore
 * replaces, or a user removes and re-creates): an instance of the declared
 * watcher — its policy, its catalog entry, its label — is held while a dir is
 * at the path, and opened again on a new one, heard by a hub children watch
 * of the parent. A bare `start` instance would stay closed once its dir went.
 * While no dir is there, the declaration lists no instance for it. Rejects
 * only when the parent cannot be watched.
 */
export async function startEventualFileWatcher(
  decl: FileWatcherDecl,
  opts: EventualFileWatcherOptions,
): Promise<{ stop(): Promise<void> }> {
  return followDir({
    dir: opts.dir,
    watchParent: acquireDirWatch,
    open: async ({ onChange, onLost }) => {
      const watcher = await decl.start({
        dirs: [opts.dir],
        label: opts.label,
        onChange,
        onLost: (_dir, error) => onLost(error),
      });
      return () => watcher.stop();
    },
    onChange: opts.onChange,
    onLost: opts.onLost,
  });
}
