import { basename, dirname } from "node:path";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { locateHostDir } from "../../server/internal/archive/locate";
import { watchHostPathOver } from "./version";
import {
  isGone,
  rearmable,
  resolveOnDisk,
  watchEntryOver,
  type AcquireDirWatch,
} from "./watch-entry";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

export type { AcquireDirWatch } from "./watch-entry";

/**
 * What changed in a watched folder: the entries named (by name, created,
 * written or removed), or anything at all — the folder itself appeared, went
 * or was replaced, it lives in an archive whose file changed, or the native
 * watch lost events — so a reader keeping the folder's entries must read it
 * all again.
 */
export type HostDirChange =
  { kind: "entries"; names: ReadonlySet<string> } | { kind: "all" };

const ALL: HostDirChange = { kind: "all" };

/**
 * Call `onChange` whenever what the absolute host folder `path` holds may have
 * changed — an entry of it created, written, renamed or removed, the folder
 * itself replaced, removed or (re)created — until the returned release runs,
 * saying which entries (a {@link HostDirChange}), so a reader that keeps the
 * folder's entries re-reads only those.
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
  path: UserPath,
  onChange: (change: HostDirChange) => void,
): Promise<DirWatchRelease> {
  return watchHostDirOver(acquireDirWatch, path, onChange);
}

/** {@link watchHostDir} over the given directory watches. */
export async function watchHostDirOver(
  acquire: AcquireDirWatch,
  path: UserPath,
  onChange: (change: HostDirChange) => void,
): Promise<DirWatchRelease> {
  const located = await locateHostDir(path);
  if (located.kind === "archive") {
    return watchHostPathOver(acquire, located.file, () => onChange(ALL));
  }
  return rearmable(async (rearm) => {
    // The hub takes the folder as the filesystem reports it (no symlinked
    // prefix), and its events name paths so.
    const found = await resolveOnDisk(path);
    if (found.kind !== "folder") {
      // Missing, unreadable or no folder (a file, a socket): it holds no
      // entries until a folder is there — wait for its entry to change.
      return watchEntryOver(acquire, path, () => rearm(() => onChange(ALL)));
    }
    const dir = found.real;
    try {
      return await acquire({
        dir,
        scope: "children",
        onChange: (events) => {
          // The folder itself went (removed, or moved away): wait for it.
          // Whatever lands at the path then is another folder — read all of
          // it, as for one created there. Its own mtime (an `update` naming
          // it) changes none of its entries.
          const own = events.filter((e) => e.path === dir);
          if (own.some((e) => e.type === "delete")) rearm();
          if (own.some((e) => e.type !== "update")) {
            onChange(ALL);
            return;
          }
          const names = new Set(
            events
              .filter((e) => e.path !== dir && dirname(e.path) === dir)
              .map((e) => basename(e.path)),
          );
          if (names.size > 0) onChange({ kind: "entries", names });
        },
        // Events may have been dropped — anything in the folder may have
        // changed — and the watch heard may be dead (its root retired): open
        // it again, and read all of the folder once it is armed.
        onLost: () => rearm(() => onChange(ALL)),
      });
    } catch (err) {
      // Gone between the realpath and the watch opening: wait for it instead.
      // Anything else is the hub's failure, and propagates.
      if (!(await isGone(path))) throw err;
      return watchEntryOver(acquire, path, () => rearm(() => onChange(ALL)));
    }
  }, path);
}
