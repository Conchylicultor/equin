import { realpath } from "node:fs/promises";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { locateHostDir } from "../../server/internal/archive/locate";
import { classifyFsError } from "../../server/internal/path";
import { watchHostPathOver } from "./version";
import {
  isGone,
  rearmable,
  watchEntryOver,
  type AcquireDirWatch,
} from "./watch-entry";

export type { AcquireDirWatch } from "./watch-entry";

/**
 * Call `onChange` whenever what the absolute host folder `path` holds may have
 * changed — an entry of it created, written, renamed or removed, the folder
 * itself replaced, removed or (re)created — until the returned release runs.
 * What a listing (or a peek) of the folder reads, kept fresh:
 *
 * - **On disk:** a children-scope watch of the folder through the shared dir
 *   hub — it rides a folder-tree watch already open above it, and otherwise
 *   opens a single-directory watch of the folder alone, never a recursive one
 *   (`/` or `~` cost one handle). While the folder is not there — or once it
 *   goes — its entry is waited for (`watchEntryOver`, climbing to the nearest
 *   folder that is there), and the folder's watch re-armed when it appears.
 * - **Inside an archive** (or an archive file listed as its root): a watch of
 *   the archive file — its members change only when it does.
 *
 * Not heard: a change one level further down. A child folder's own modified
 * time and size move when an entry is created in it, but its listing row
 * keeps the values of the folder's last read until the folder itself changes
 * (hearing them would watch every child folder). A symlinked child's row
 * describes its target, whose changes are not heard either.
 *
 * The runtime reads a tuple only once this watch is live (`whileSubscribed`
 * is awaited first), so nothing is re-read at arm time.
 */
export function watchHostDir(
  path: string,
  onChange: () => void,
): Promise<DirWatchRelease> {
  return watchHostDirOver(acquireDirWatch, path, onChange);
}

/** {@link watchHostDir} over the given directory watches. */
export async function watchHostDirOver(
  acquire: AcquireDirWatch,
  path: string,
  onChange: () => void,
): Promise<DirWatchRelease> {
  const located = await locateHostDir(path);
  if (located.kind === "archive") {
    return watchHostPathOver(acquire, located.file, onChange);
  }
  return rearmable(async (rearm) => {
    let dir: string;
    try {
      // The hub takes the folder as the filesystem reports it (no symlinked
      // prefix), and its events name paths so.
      dir = await realpath(path);
    } catch (err) {
      // Missing or unreadable: wait for it to appear (or change) instead.
      classifyFsError(err);
      return watchEntryOver(acquire, path, () => rearm(onChange));
    }
    try {
      return await acquire({
        dir,
        scope: "children",
        onChange: (events) => {
          // The folder itself went (removed, or moved away): wait for it.
          // Any other event naming it (its own mtime) changes nothing about
          // the watch.
          if (events.some((e) => e.path === dir && e.type === "delete")) {
            rearm();
          }
          onChange();
        },
      });
    } catch (err) {
      // Gone between the realpath and the watch opening: wait for it instead.
      // Anything else is the hub's failure, and propagates.
      if (!(await isGone(path))) throw err;
      return watchEntryOver(acquire, path, () => rearm(onChange));
    }
  }, path);
}
