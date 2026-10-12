import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineFileWatcher } from "./define";
import {
  createDirWatchHub,
  type DirWatchRelease,
  type DirWatchRequest,
} from "./dir-hub";

/**
 * The one declaration every hub watch is an instance of — one instance per
 * root, labelled by it. No `ignore`: the hub serves listings of any folder
 * (`node_modules`, `.git`), so what a watcher does not care about it filters
 * itself.
 */
export const dirWatcher = defineFileWatcher({
  name: "file-watcher.dirs",
  description:
    "Shared directory watches: one native watch per watched folder tree, however many live values (a listing, a checkout's git status, a conversation's edited files) are reading a folder inside it.",
  debounceMs: 200,
  ceilingMs: 2000,
});

const hub = createDirWatchHub(async (root, onChange) => {
  const watch = await dirWatcher.start({ dirs: [root], label: root, onChange });
  return {
    stop: () => runTracked("file-watcher.dirs:stop", () => watch.stop()),
  };
});

/**
 * Hear the changes in `dir` (its direct entries, or its whole subtree) until
 * the returned release runs. Watchers of the same folder tree share one native
 * watch: a dir under an already-watched root rides it. Resolves once the watch
 * is live; rejects when `dir` cannot be watched.
 *
 * ```ts
 * whileSubscribed: async ({ path }, notify) =>
 *   acquireDirWatch({ dir: path, scope: "children", onChange: () => notify() }),
 * ```
 */
export function acquireDirWatch(
  request: DirWatchRequest,
): Promise<DirWatchRelease> {
  return hub.acquire(request);
}
