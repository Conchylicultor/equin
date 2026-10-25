import {
  createFileWatcher,
  type FileWatcher,
  type FileWatcherOptions,
} from "../../shared/engine";

/**
 * The engine's options for a watch that lives exactly as long as one CLI
 * command. `dirs` and `onChange` are required; `name` labels the profiler span.
 */
export type WatchForCommandOptions = FileWatcherOptions;

/**
 * Watch files for the life of a foreground `./equin` command (`await`
 * waiting on an op). The same engine as `defineFileWatcher` — debounce,
 * ceiling, `onLost` — with no registry: a CLI process has no Background
 * activity catalog, and a wait is not background activity. Stop it before the
 * command returns.
 */
export function watchForCommand(
  opts: WatchForCommandOptions,
): Promise<FileWatcher> {
  return createFileWatcher(opts);
}
