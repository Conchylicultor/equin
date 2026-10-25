import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { onWatcherActivity } from "@plugins/infra/plugins/file-watcher/server";
import { fileWatchersBackgroundKind } from "./internal/provider";

export default {
  description:
    "File watchers in the Background activity catalog: registers the `file-watcher` background kind — every declaration made with defineFileWatcher under File watchers, triggered on file change, its scope from mainOnly, and its facts (open instances and the directories each watches, the native backend, the last change batch) — plus its handler runs in this process. Pushes the catalog as instances open and close and as runs land (throttled by the file-watcher registry).",
  register: [fileWatchersBackgroundKind],
  onReady: () => {
    // For the life of the process: the registry already throttles per
    // declaration, and the catalog value throttles the pushes.
    onWatcherActivity((name) => fileWatchersBackgroundKind.changed(name));
  },
} satisfies ServerPluginDefinition;
