import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  acquireEventualDirWatch,
  startEventualFileWatcher,
} from "./internal/eventual-dir-watch";
export type { EventualFileWatcherOptions } from "./internal/eventual-dir-watch";

export default {
  description:
    "acquireEventualDirWatch: acquireDirWatch for a dir that may not exist yet or may go and come back (a checkout whose path is recorded before it is created, and reaped later) — a children watch of its parent, and the dir's own watch while it is there, its appearing and going delivered as create / delete events at the dir. startEventualFileWatcher(decl, {dir, label, onChange, onLost}): the same follow for a declared watcher — an instance of it (its policy and catalog entry) held while a dir is at the path and opened again on a new one, where a bare start() stays closed once its dir went.",
} satisfies MachinePluginDefinition;
