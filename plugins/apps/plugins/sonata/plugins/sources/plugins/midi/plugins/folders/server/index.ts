import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { midiFoldersConfig } from "../shared/config";
import { importMidiFileJob } from "./internal/import-job";
import { midiFoldersWarmup } from "./internal/reconcile";
import {
  folderSongCountServed,
  folderStatusServed,
  handleRecheckMidiFolders,
} from "./internal/status-values";
import { recheckMidiFolders } from "../shared/status";
import {
  midiFoldersWatcher,
  startMidiFolderWatcher,
  stopMidiFolderWatcher,
} from "./internal/watcher";

export default {
  description:
    "Watches configured folders for .mid/.midi files and mirrors them into the Sonata library: auto-imports on create/edit (via a per-file job), badges 'source deleted' on removal, and reconciles drift on boot and config change. The watched-folder list is a config_v2 listField. Probes each folder (ok / missing / not a folder / denied / unreadable): only readable folders are watched and walked, and the statuses are served live (sonata.midi-folders.status) with a Check again endpoint, plus each folder's imported-song count.",
  httpRoutes: { [recheckMidiFolders.route]: handleRecheckMidiFolders },
  contributions: [
    ConfigV2.Register({ descriptor: midiFoldersConfig }),
    ...folderStatusServed.declare,
    ...folderSongCountServed.declare,
  ],
  register: [importMidiFileJob, midiFoldersWarmup, midiFoldersWatcher],
  // onReady now only MOUNTS the watcher (cheap); the heavy boot reconcile is the
  // deferred `midiFoldersWarmup`, drained after onAllReady.
  onReady: async () => {
    await startMidiFolderWatcher();
  },
  onShutdown: async () => {
    await stopMidiFolderWatcher();
  },
} satisfies ServerPluginDefinition;
