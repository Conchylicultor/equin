import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { dirEntriesWatcher, dirWatcher } from "./internal/dir-watch";

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
  onWatchDelivery,
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
  FileFollowStartOptions,
  DeliveryLagSample,
  WatchDelivery,
} from "../shared/registry";
export { WatchedDirGoneError } from "../shared/engine";
export { journalChangesSince, journalCursor } from "../shared/journal";
export type {
  JournalCursor,
  JournalCursorResult,
  JournalReplay,
} from "../shared/journal";
export type {
  FileWatcher,
  WatchReaction,
  WatchLost,
  WatcherBackend,
} from "../shared/engine";

export default {
  description:
    "defineFileWatcher: the one declared in-process file watcher — a named, described declaration (static policy: extensions, ignore, debounce, ceiling, writesWhileOpen, depth, mainOnly) whose start({dirs, label, onChange, onLost}) — start({files, …}) for a writesWhileOpen one, which follows writes to the named files only (kqueue on darwin, one descriptor per file; every follow of a directory shares one subscription) — opens instances over one @parcel/watcher engine (debounce + ceiling flush; no timer — a dropped event is reported to onLost, the one backstop). Records per declaration its open instances, last change batch and a ring of handler runs for the Background activity catalog (onWatcherActivity / listFileWatchers / fileWatcherRecentRuns). The cli barrel's watchForCommand is the same engine for a foreground command, with no registry. acquireDirWatch({dir, scope, onChange}) is the shared directory-watch hub: one native watch per folder tree, refcounted, a dir under a watched root riding its watch, with subtree or children (depth-1 listing) scope — a children request with no root above it opening only a single-directory watch (depth children), never a recursive one. On macOS every FSEvents watch with no ignore rides the process's stream pool — one stream per watched root, a dir under an open recursive stream riding it, whatever declaration or depth asks (fsEventsStreams reads it).",
  register: [dirWatcher, dirEntriesWatcher],
} satisfies ServerPluginDefinition;
