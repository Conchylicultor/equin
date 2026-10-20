import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
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

/**
 * The disk entry whose bytes answer for `path`: the path itself, or — for a
 * member of an archive — the archive file holding it.
 */
async function anchorOf(path: string): Promise<string> {
  const located = await locateHostPath(path);
  return located.kind === "archive" ? located.file : path;
}

/** The revision of the absolute host path `path` (see `FileVersionSchema`). */
export async function hostPathVersion(path: string): Promise<FileVersion> {
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
 *   modified time) moves when an entry is created or removed in it.
 *
 * Every read serving through it (stat, text, bytes, version) is loaded only
 * once its watch is live — the runtime awaits `whileSubscribed` before the
 * first read — so no change between the two can be missed, and nothing is
 * re-read at arm time.
 */
export function watchHostPath(
  path: string,
  onChange: () => void,
): Promise<DirWatchRelease> {
  return watchHostPathOver(acquireDirWatch, path, onChange);
}

/** {@link watchHostPath} over the given directory watches. */
export function watchHostPathOver(
  acquire: AcquireDirWatch,
  path: string,
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
        const folder = await resolveOnDisk(dirname(anchor));
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
async function entryKind(path: string): Promise<"folder" | "other" | "gone"> {
  try {
    return (await stat(path)).isDirectory() ? "folder" : "other";
  } catch (err) {
    classifyFsError(err);
    return "gone";
  }
}

/** A children-scope watch of the folder `dir`; a re-arm when it went meanwhile. */
async function watchEntriesOf(
  acquire: AcquireDirWatch,
  dir: string,
  onChange: () => void,
  rearm: Rearm,
): Promise<DirWatchRelease> {
  try {
    return await acquire({
      dir,
      scope: "children",
      onChange: () => onChange(),
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
    let abs: string;
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
    let abs: string;
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
