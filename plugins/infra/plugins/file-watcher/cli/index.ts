// The file-watcher engine for a foreground `./singularity` command. No
// default export: this is shared CLI machinery, not a command declaration, so
// it is not registered and not loaded on every invocation.
export { watchForCommand } from "./internal/watch-for-command";
export type { WatchForCommandOptions } from "./internal/watch-for-command";
export type {
  FileWatcher,
  WatchReaction,
  WatchReconcile,
} from "../shared/engine";
