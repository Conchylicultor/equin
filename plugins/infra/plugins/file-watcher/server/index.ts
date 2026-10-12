import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { dirWatcher } from "./internal/dir-watch";

export { defineFileWatcher } from "./internal/define";
export type { ServerFileWatcherSpec } from "./internal/define";
export { acquireDirWatch } from "./internal/dir-watch";
export type {
  DirWatchRelease,
  DirWatchRequest,
  DirWatchScope,
} from "./internal/dir-hub";
export {
  BATCH_SAMPLE_MAX,
  fileWatcherRecentRuns,
  listFileWatchers,
  onWatcherActivity,
} from "../shared/registry";
export type {
  FileChangeEvent,
  FileWatcherBatch,
  FileWatcherDecl,
  FileWatcherInstanceInfo,
  FileWatcherSnapshot,
  FileWatcherSpec,
  FileWatcherStartOptions,
} from "../shared/registry";
export { WRITES_WHILE_OPEN_MAX_ENTRIES } from "../shared/engine";
export type { FileWatcher, WatcherBackend } from "../shared/engine";

export default {
  description:
    "defineFileWatcher: the one declared in-process file watcher — a named, described declaration (static policy: extensions, ignore, debounce, ceiling, writesWhileOpen, reconcile, mainOnly) whose start({dirs, label, onChange, onReconcile}) opens instances over one @parcel/watcher engine (debounce + ceiling flush, reconcile timer, kqueue sizing). Records per declaration its open instances, last change batch and a ring of handler runs for the Background activity catalog (onWatcherActivity / listFileWatchers / fileWatcherRecentRuns). The cli barrel's watchForCommand is the same engine for a foreground command, with no registry. acquireDirWatch({dir, scope, onChange}) is the shared directory-watch hub: one native watch per folder tree, refcounted, a dir under a watched root riding its watch, with subtree or children (depth-1 listing) scope.",
  register: [dirWatcher],
} satisfies ServerPluginDefinition;
