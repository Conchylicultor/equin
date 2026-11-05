import type { FileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// The folders the watcher has open, each with its own watch (`watcher.ts`
// opens and closes them). THE corpus of the MIDI index and of reverse drift
// (`reconcile.ts`): a folder is walked, caught up or marked missing only while
// a watch hears it, so the index's "caught up" never covers a stretch nothing
// was listening to — and a folder that stays readable keeps its watch across a
// re-mount, so it never has such a stretch.
const open = new Map<UserPath, FileWatcher>();

/** The watched folders' real paths, in the order they were opened. */
export const watchedDirs = (): UserPath[] => [...open.keys()];

/** Record `dir`'s freshly opened watch. */
export function addWatch(dir: UserPath, watch: FileWatcher): void {
  open.set(dir, watch);
}

/** Forget `dir`'s watch and hand it back to be stopped (none open: `undefined`). */
export function takeWatch(dir: UserPath): FileWatcher | undefined {
  const watch = open.get(dir);
  open.delete(dir);
  return watch;
}
