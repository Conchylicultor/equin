import { dirEntriesWatcher, dirWatcher } from "../internal/dir-watch";

let registered = false;

/**
 * Register the shared directory-watch hub's two declarations, as the
 * file-watcher server plugin's `register: [...]` does at boot — for a suite
 * that opens the real hub (`acquireDirWatch`, `acquireEventualDirWatch`,
 * `startEventualFileWatcher`) without booting the graph. Idempotent: suites
 * sharing a process may each call it.
 */
export function registerDirWatchHub(): void {
  if (registered) return;
  registered = true;
  dirWatcher.register();
  dirEntriesWatcher.register();
}
