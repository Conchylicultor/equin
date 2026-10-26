import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import {
  acquireDirWatch,
  type DirWatchRelease,
  type DirWatchRequest,
  type FileChangeEvent,
} from "../../server";

type Acquire = (request: DirWatchRequest) => Promise<DirWatchRelease>;

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
 * `acquire`, for a dir that may not exist yet, or may go and come back: a
 * children watch of its parent hears the dir appear, go or be replaced, and
 * while it is there a watch of the dir itself (`request`'s scope) is held. Its
 * appearing and going reach `onChange` as a `create` / `delete` event at `dir`
 * — a replacement as both — alongside the dir's own changes, through one
 * reaction (one call at a time). Resolves once the parent's watch (and the
 * dir's, when it is there) is open; rejects when the parent cannot be watched
 * (it is missing), holding nothing.
 */
export async function acquireEventualDirWatchWith(
  acquire: Acquire,
  request: DirWatchRequest,
): Promise<DirWatchRelease> {
  const { dir, onChange } = request;
  const name = basename(dir);
  let stopped = false;
  let inner: { ino: number; release: DirWatchRelease } | null = null;
  // The first sync finds the dir as it is: nothing appeared or went yet.
  let synced = false;

  const reaction = createCoalescer<FileChangeEvent>({
    run: (events) => (stopped ? undefined : onChange(events)),
  });

  // Bring the held watch in line with what is at `dir` now. One run at a
  // time (a coalescer), so two parent batches never race two opens.
  const sync = createCoalescer({
    run: async () => {
      const first = !synced;
      synced = true;
      const ino = await dirInode(dir);
      if (stopped || inner?.ino === ino) return;
      const presence: FileChangeEvent[] = [];
      const report = (): void => {
        if (!first && presence.length > 0) reaction.trigger(presence);
      };
      if (inner !== null) {
        inner.release();
        inner = null;
        presence.push({ type: "delete", path: dir });
      }
      if (ino !== null) {
        let release: DirWatchRelease;
        try {
          release = await acquire({ ...request, onChange: reaction.trigger });
        } catch (err) {
          // Gone again between the stat and the open: the parent's watch
          // hears it come back. Any other failure is real.
          if ((await dirInode(dir)) !== null) throw err;
          report();
          return;
        }
        if (stopped) {
          release();
          return;
        }
        inner = { ino, release };
        presence.push({ type: "create", path: dir });
      }
      report();
    },
  });

  const outer = await acquire({
    dir: dirname(dir),
    scope: "children",
    onChange: (events) =>
      events.some((e) => basename(e.path) === name) ? sync.run() : undefined,
    onLost: (error) => {
      request.onLost?.(error);
      sync.trigger();
    },
  });
  try {
    await sync.run();
  } catch (err) {
    outer();
    throw err;
  }
  return () => {
    if (stopped) return;
    stopped = true;
    outer();
    inner?.release();
    inner = null;
  };
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
