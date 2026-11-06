/**
 * A watched dir itself went — removed, moved away, or replaced by another (its
 * inode changed) — so its watch is closed and hears nothing more of whatever
 * lands at that path. Handed to `onLost`: re-derive (the dir is gone), and open
 * a new watch if the dir comes back. The same fact for a `writesWhileOpen`
 * follow: the dir of a followed file went.
 */
export class WatchedDirGoneError extends Error {
  constructor(readonly dir: string) {
    super(`[file-watcher] the watched dir ${dir} went; its watch is closed`);
    this.name = "WatchedDirGoneError";
  }
}
