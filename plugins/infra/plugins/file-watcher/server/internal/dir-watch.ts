import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineFileWatcher } from "./define";
import type { FileChangeEvent } from "../../shared/registry";
import {
  createDirWatchHub,
  type DirWatchRelease,
  type DirWatchRequest,
} from "./dir-hub";

/**
 * The declaration every recursive hub watch is an instance of — one instance per
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

/**
 * The hub's single-directory watches: what a `children` request (a folder's
 * listing) opens when no recursive root above it is open — two handles per
 * folder (it and its parent, to hear it go), never a watch of the tree below
 * it. One instance per dir.
 */
export const dirEntriesWatcher = defineFileWatcher({
  name: "file-watcher.dir-entries",
  description:
    "Shared single-folder watches: one per folder whose entries a live value (a listing, a folder peek, a file's stat) is reading, when no folder-tree watch above it is open — the folder's direct entries only, so viewing a huge folder never watches everything below it.",
  depth: "children",
  debounceMs: 200,
  ceilingMs: 2000,
});

const startOf =
  (decl: typeof dirWatcher) =>
  async (root: string, onChange: (events: FileChangeEvent[]) => void) => {
    const watch = await decl.start({ dirs: [root], label: root, onChange });
    return {
      stop: () => runTracked(`${decl.name}:stop`, () => watch.stop()),
    };
  };

const hub = createDirWatchHub({
  subtree: startOf(dirWatcher),
  children: startOf(dirEntriesWatcher),
});

/**
 * Hear the changes in `dir` (its direct entries, or its whole subtree) until
 * the returned release runs. Watchers of the same folder tree share one native
 * watch: a dir under an already-watched root rides it. A `children` request
 * with no root above it opens only a single-directory watch of its dir. Resolves once the watch
 * is open — a single-directory one goes live a moment later (the engine's
 * `depth: "children"`); rejects when `dir` cannot be watched.
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
