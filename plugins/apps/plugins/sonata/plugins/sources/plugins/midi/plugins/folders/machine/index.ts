import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { recheckMidiFolders } from "../shared/status";
import { importMidiFileJob } from "./internal/import-job";
import { midiFoldersWarmup } from "./internal/reconcile";
import {
  folderStatusServed,
  handleRecheckMidiFolders,
} from "./internal/status-values";
import {
  midiFoldersWatcher,
  startMidiFolderWatcher,
  stopMidiFolderWatcher,
} from "./internal/watcher";

export default {
  description:
    "Watched MIDI folders, desktop half (needsMachine: the folders are on this computer): watches each configured folder for .mid/.midi files and mirrors them into the Sonata library — auto-imports on create/edit (via a per-file job), badges 'source deleted' on removal, and reconciles drift on boot and config change. Probes each folder (ok / missing / not a folder / denied / unreadable): only readable folders are watched and walked, and the statuses are served live (sonata.midi-folders.status) with a Check again endpoint.",
  httpRoutes: { [recheckMidiFolders.route]: handleRecheckMidiFolders },
  contributions: [...folderStatusServed.declare],
  register: [importMidiFileJob, midiFoldersWarmup, midiFoldersWatcher],
  // onReady only MOUNTS the watcher (cheap); the heavy boot reconcile is the
  // deferred `midiFoldersWarmup`, drained after onAllReady.
  onReady: async () => {
    await startMidiFolderWatcher();
  },
  onShutdown: async () => {
    await stopMidiFolderWatcher();
  },
} satisfies MachinePluginDefinition;
