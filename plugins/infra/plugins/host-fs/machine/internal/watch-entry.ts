import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import type {
  DirWatchRelease,
  DirWatchRequest,
  FileChangeEvent,
} from "@plugins/infra/plugins/file-watcher/server";
import { classifyFsError } from "../../server/internal/path";

/** Opens one directory watch — the shared hub's `acquireDirWatch`, or a test's. */
export type AcquireDirWatch = (
  request: DirWatchRequest,
) => Promise<DirWatchRelease>;

/** Whether `path` is not there (or not readable) any more. */
export async function isGone(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return false;
  } catch (err) {
    classifyFsError(err);
    return true;
  }
}

/** Where `path` resolves on disk, or that it is not there (or not readable). */
export type Resolved = { kind: "there"; real: string } | { kind: "gone" };

/** `realpath(path)`, as a {@link Resolved}. */
export async function resolveOnDisk(path: string): Promise<Resolved> {
  try {
    return { kind: "there", real: await realpath(path) };
  } catch (err) {
    classifyFsError(err);
    return { kind: "gone" };
  }
}

/** Ask a later re-arm; `after` runs once it is armed. */
export type Rearm = (after?: () => void) => void;

/**
 * A watch whose shape follows the disk: `arm(rearm)` opens the watches for
 * how things stand now, and calls `rearm` when that changed (a folder went, a
 * link was replaced). One (re-)arm runs at a time; an event landing mid-arm
 * queues the next. The new watches open before the old ones are given back,
 * so a hub watch both share is never closed in between.
 *
 * Each re-arm chains from a settled base: a re-arm that fails (the hub could
 * not open a folder that is there) is reported once, the watch keeps what it
 * held, and the next event tries again. The first arm's failure rejects the
 * returned promise, holding nothing.
 */
export async function rearmable(
  arm: (rearm: Rearm) => Promise<DirWatchRelease>,
  what: string,
): Promise<DirWatchRelease> {
  let stopped = false;
  let held: DirWatchRelease | null = null;
  let arming: Promise<void> = Promise.resolve();

  const once = async (): Promise<void> => {
    if (stopped) return;
    const release = await arm(rearm);
    const previous = held;
    held = null;
    if (stopped) release();
    else held = release;
    previous?.();
  };

  function rearm(after?: () => void): void {
    const next = arming.then(once).then(() => {
      if (!stopped) after?.();
    });
    arming = next.then(
      () => undefined,
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[host-fs] re-arming the watch of ${what} failed`, error);
        reportServerError({
          message: `[host-fs] re-arming the watch of ${what} failed: ${error.message}`,
          stack: error.stack,
          errorType: error.name,
        });
      },
    );
  }

  await once();
  return () => {
    stopped = true;
    const release = held;
    held = null;
    release?.();
  };
}

/**
 * Call `onChange` whenever the absolute host path `path`'s own entry may have
 * changed — created, written, replaced or removed — until the returned
 * release runs: a children-scope watch of the folder holding it. While that
 * folder is not there, the nearest ancestor that is waits for the next
 * missing folder of the path to appear, and the watch moves one level down
 * each time one does, until it reaches the entry's own folder (a folder going
 * moves it back up). So a path whose folders do not exist yet is still heard
 * once they and it are created. The entry is named as the filesystem reports
 * it (no symlinked prefix); a symlink entry is its own, not its target.
 */
export function watchEntryOver(
  acquire: AcquireDirWatch,
  path: string,
  onChange: (events: FileChangeEvent[]) => void,
): Promise<DirWatchRelease> {
  return rearmable(async (rearm) => {
    // The nearest folder of the path that is there, and the path's next
    // component below it (the entry itself once that folder is its parent).
    let next = path;
    let dir = dirname(path);
    let found = await resolveOnDisk(dir);
    while (found.kind === "gone") {
      next = dir;
      dir = dirname(dir);
      found = await resolveOnDisk(dir);
    }
    const watched = found.real;
    const entry = join(watched, basename(next));
    const reachesEntry = next === path;
    try {
      return await acquire({
        dir: watched,
        scope: "children",
        onChange: (events) => {
          const mine = events.filter(
            (e) => e.path === entry || e.path === watched,
          );
          if (mine.length === 0) return;
          // The watched folder went: wait for it one level up.
          const folderGone = mine.some(
            (e) => e.path === watched && e.type === "delete",
          );
          if (folderGone) rearm();
          if (reachesEntry) {
            onChange(mine);
            return;
          }
          // A missing folder of the path appeared (or the one watched went):
          // move the watch, and read again once it is armed — a write in
          // between is then heard by the read, not missed by the watch.
          if (mine.some((e) => e.path === entry)) {
            rearm(() => onChange(mine));
          } else onChange(mine);
        },
      });
    } catch (err) {
      // Gone between the realpath and the watch opening: wait one level up.
      // Anything else is the hub's failure, and propagates.
      if (!(await isGone(watched))) throw err;
      rearm();
      return () => {};
    }
  }, path);
}
