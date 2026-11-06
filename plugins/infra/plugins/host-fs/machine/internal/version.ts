import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { basename, dirname, join } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { hostFsVersion, type FileVersion } from "../../core";
import { locateHostPath } from "../../server/internal/archive/locate";
import { classifyFsError, resolveHostPath } from "../../server/internal/path";
import {
  isGone,
  rearmable,
  resolveOnDisk,
  watchEntryOver,
  type AcquireDirWatch,
  type Rearm,
} from "./watch-entry";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * The disk entry whose bytes answer for `path`: the path itself, or — for a
 * member of an archive — the archive file holding it.
 */
async function anchorOf(path: UserPath): Promise<UserPath> {
  const located = await locateHostPath(path);
  return located.kind === "archive" ? located.file : path;
}

/** The revision of the absolute host path `path` (see `FileVersionSchema`). */
export async function hostPathVersion(path: UserPath): Promise<FileVersion> {
  try {
    const st = await stat(await anchorOf(path));
    return { stamp: `${st.ino}:${st.size}:${st.mtimeMs}` };
  } catch (err) {
    // Missing or unreadable: nothing to stamp. The reader's own read says which.
    classifyFsError(err);
    return { stamp: null };
  }
}

/**
 * Call `onChange` whenever what the absolute host path `path` reads as may
 * have changed, until the returned release runs:
 *
 * - **its entry** (or its archive's) created, written, replaced or removed —
 *   a children-scope watch of the folder holding it, through the shared dir
 *   hub (so it rides any watch already open above it, a checkout's). While
 *   that folder is not there, the nearest one that is waits for it, so a
 *   path whose folder is created later is still heard (`watchEntryOver`);
 * - **where it points**, for a symlink: its target's entry too, since what it
 *   reads (bytes, size, modified time) is the target's. A change to the link
 *   itself re-resolves it;
 * - **its entries**, for a folder: what a folder's own stat reports (its
 *   modified time) moves when an entry is created, removed or renamed over
 *   in it — and only then: a write inside an entry is not heard.
 *
 * Every read serving through it (stat, text, bytes, version) is loaded only
 * once its watch is live — the runtime awaits `whileSubscribed` before the
 * first read — so no change between the two can be missed, and nothing is
 * re-read at arm time.
 */
export function watchHostPath(
  path: UserPath,
  onChange: () => void,
): Promise<DirWatchRelease> {
  return watchHostPathOver(acquireDirWatch, path, onChange);
}

/** {@link watchHostPath} over the given directory watches. */
export function watchHostPathOver(
  acquire: AcquireDirWatch,
  path: UserPath,
  onChange: () => void,
): Promise<DirWatchRelease> {
  return rearmable(async (rearm) => {
    const anchor = await anchorOf(path);
    const releases: DirWatchRelease[] = [];
    const releaseAll = () => {
      for (const release of releases.splice(0)) release();
    };
    try {
      releases.push(
        // The entry replaced, removed or (re)created may point, or be,
        // elsewhere now: look again, then read (once — a second notify would
        // be a second whole re-read of an on-demand value).
        await watchEntryOver(acquire, anchor, () => rearm(onChange)),
      );
      const target = await resolveOnDisk(anchor);
      if (target.kind === "there") {
        const real = target.real;
        const folder = await resolveOnDisk(asUserPath(dirname(anchor)));
        const entry =
          folder.kind === "there" ? join(folder.real, basename(anchor)) : null;
        if (real !== entry) {
          releases.push(await watchEntryOver(acquire, real, () => onChange()));
        }
        if ((await entryKind(real)) === "folder") {
          releases.push(await watchEntriesOf(acquire, real, onChange, rearm));
        }
      }
    } catch (err) {
      releaseAll();
      throw err;
    }
    return releaseAll;
  }, path);
}

/** What `path` is now: a folder, something else, or not there. */
async function entryKind(path: UserPath): Promise<"folder" | "other" | "gone"> {
  try {
    return (await stat(path)).isDirectory() ? "folder" : "other";
  } catch (err) {
    classifyFsError(err);
    return "gone";
  }
}

/**
 * A children-scope watch of the folder `dir`, heard only when the folder's own
 * stat moved (`hostPathVersion`: an entry created, removed or renamed over —
 * whatever the watcher calls the event); a write inside an entry leaves it as
 * it was, so it is no change of what the folder reads as. A re-arm when the
 * folder went meanwhile.
 */
async function watchEntriesOf(
  acquire: AcquireDirWatch,
  dir: UserPath,
  onChange: () => void,
  rearm: Rearm,
): Promise<DirWatchRelease> {
  // Read before the watch opens: a change after it is heard against it.
  let last = (await hostPathVersion(dir)).stamp;
  const heard = async (): Promise<void> => {
    const { stamp } = await hostPathVersion(dir);
    if (stamp === last) return;
    last = stamp;
    onChange();
  };
  try {
    return await acquire({
      dir,
      scope: "children",
      // Returned: the watch runs one reaction at a time and folds the
      // batches landing meanwhile into one trailing call.
      onChange: () =>
        heard().then(undefined, (err: unknown) => {
          // Could not tell: heard, and said so.
          onChange();
          const error = err instanceof Error ? err : new Error(String(err));
          reportServerError({
            message: `[host-fs] reading the stat of ${dir} after a change failed: ${error.message}`,
            stack: error.stack,
            errorType: error.name,
          });
        }),
    });
  } catch (err) {
    if (!(await isGone(dir))) throw err;
    rearm(onChange);
    return () => {};
  }
}

/** Whether `resolveHostPath` refused the spelling (a 400), not the disk. */
function isInvalidPath(err: unknown): err is HttpError {
  return err instanceof HttpError && err.status === 400;
}

/**
 * `notified` by a watch of the file's folder for as long as the tuple has a
 * subscriber. The start is awaited on the subscribe path: the version is read
 * beside the file's own content read, never ahead of it, so holding its
 * sub-ack until the watch is live delays nothing on screen.
 */
export const hostFsVersionServed = serveValue(hostFsVersion, {
  source: "external",
  changes: "notified",
  loader: ({ path }) => {
    let abs: UserPath;
    try {
      abs = resolveHostPath(path);
    } catch (err) {
      if (isInvalidPath(err)) {
        throw hostFsVersion.refuse("invalid-path", err.message);
      }
      throw err;
    }
    return hostPathVersion(abs);
  },
  whileSubscribed: async ({ path }, notify) => {
    let abs: UserPath;
    try {
      abs = resolveHostPath(path);
    } catch (err) {
      // The loader refuses it; there is nothing to watch.
      if (isInvalidPath(err)) return () => {};
      throw err;
    }
    return watchHostPath(abs, () => notify());
  },
});
