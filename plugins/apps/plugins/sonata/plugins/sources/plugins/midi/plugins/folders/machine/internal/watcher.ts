import {
  defineFileWatcher,
  type FileChangeEvent,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { watchConfig } from "@plugins/config_v2/server";
import type { Disposable } from "@plugins/config_v2/core";
import {
  getSongMidiBySourcePath,
  setSourceMissing,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { midiFoldersConfig } from "../../shared/config";
import { importMidiFileJob } from "./import-job";
import {
  markMidiFolderWatched,
  markMidiPathsChanged,
  reconcile,
  reconcileAfterLostEvents,
} from "./reconcile";
import {
  onFolderStatusChange,
  readableDirs,
  refreshFolderStatuses,
} from "./folder-status";
import { addWatch, takeWatch, watchedDirs } from "./watched-dirs";

/**
 * One instance over the configured folders, re-opened (stop + start) whenever
 * the folder list changes.
 */
export const midiFoldersWatcher = defineFileWatcher({
  name: "sonata-midi-folders.folders",
  description:
    "Watches your MIDI folders: imports a .mid file when it is added or edited and badges its song when the file is deleted.",
  extensions: [".mid", ".midi"],
  // No timer (the file-watcher engine has none). A reconcile re-walks every watched folder recursively, and
  // a watched folder may be a big tree (`~/Downloads`: 26k dirs for 31 MIDI
  // files, 2.6 s of readdir per walk) — on a 30 s timer that was 2.6 s of I/O
  // every 30 s in EVERY backend, to find nothing changed. A dropped fsevent is
  // not silent: the native watch errors, and the engine reports it as `onLost`,
  // which re-derives the folder set below (`lostReconciles`).
});

// A lost-events reconcile, coalesced: an error burst on several dirs costs at
// most one running plus one pending walk.
const lostReconciles = createCoalescer({
  run: () =>
    runTracked("midi-folders:reconcile", () => reconcileAfterLostEvents()),
});

// Mirrors infra/git/git-watcher's manager: module-level mutable state, `started`
// guard, async start/stop. The watched set follows the readable configured
// folders (via watchConfig and the folder probes) — config_v2 drives the dir
// set, so there is no polling. One watch per folder (`watched-dirs.ts`), so a
// re-mount opens and closes only the folders that changed.
let configSub: Disposable | null = null;
let statusSub: (() => void) | null = null;
let mounting = false;
let started = false;

// Serialize reconfigure runs: overlapping config changes (or a config change
// racing the immediate-on-register call) must not open a folder twice.
let reconfiguring: Promise<void> = Promise.resolve();

async function onChange(events: FileChangeEvent[]): Promise<void> {
  // The corpus index re-checks these on the next reconcile, instead of walking.
  markMidiPathsChanged(events.map((e) => e.path));
  for (const event of events) {
    if (event.type === "create" || event.type === "update") {
      await importMidiFileJob.enqueue({ sourcePath: event.path });
    } else if (event.type === "delete") {
      // Keep the song, badge it. Trivial inline UPDATE — no job needed.
      const existing = await getSongMidiBySourcePath(event.path);
      if (existing) await setSourceMissing(existing.songId, true);
    }
  }
}

// Bring the open watches in line with the readable folders: close the ones no
// longer readable (or configured), open the newly readable ones — a folder that
// stays keeps its watch, so nothing under it goes unheard. The immediate (boot)
// call mounts ONLY — the boot catch-up is the deferred `midiFoldersWarmup`. A
// later config change or readable-set change (`{ reconcile: true }`) reconciles
// inline: a newly watched folder's pre-existing files emit no events, and the
// reconcile catches it up from the journal (or walks it, the first time).
async function reconfigure(opts: { reconcile: boolean }): Promise<void> {
  // Chain onto the previous run so two config changes can't race two watches.
  reconfiguring = reconfiguring.then(async () => {
    // Probe first: only readable folders are watched — an unreadable one would
    // fail the watch; it is shown in the library instead. (`mounting` keeps
    // this probe's own change from queueing a second remount.)
    mounting = true;
    try {
      await refreshFolderStatuses();
    } finally {
      mounting = false;
    }
    const dirs = readableDirs();
    for (const dir of watchedDirs()) {
      if (!dirs.includes(dir)) await takeWatch(dir)?.stop();
    }
    for (const dir of dirs) {
      if (watchedDirs().includes(dir)) continue;
      const watch = await midiFoldersWatcher.start({
        dirs: [dir],
        onChange: (events) =>
          runTracked("midi-folders:change", () => onChange(events)),
        onLost: () => lostReconciles.trigger(),
      });
      addWatch(dir, watch);
      markMidiFolderWatched(dir, watch);
    }
    if (opts.reconcile) await reconcile();
  });
  await reconfiguring;
}

export async function startMidiFolderWatcher(): Promise<void> {
  if (started) return;
  started = true;
  // watchConfig invokes the callback IMMEDIATELY on registration and again on
  // every change. The immediate call performs the first MOUNT ONLY (the boot
  // walk is a separate warm-up) — do NOT also call reconfigure() separately
  // (that would double-mount). Genuine later config-changes reconcile inline.
  let firstCall = true;
  // A re-probe that changes WHICH folders are readable (access granted, a drive
  // plugged back in — found by a reconcile or the user's Check again) re-mounts
  // the watcher and reconciles, so the folder's files are imported now.
  statusSub = onFolderStatusChange(() => {
    if (mounting || sameDirs(readableDirs(), watchedDirs())) return;
    void runTracked("midi-folders:reconfigure", () =>
      reconfigure({ reconcile: true }),
    );
  });
  configSub = watchConfig(midiFoldersConfig, () => {
    const reconcileNow = !firstCall;
    firstCall = false;
    void runTracked("midi-folders:reconfigure", () =>
      reconfigure({ reconcile: reconcileNow }),
    );
  });
}

export async function stopMidiFolderWatcher(): Promise<void> {
  if (!started) return;
  started = false;
  if (configSub) {
    configSub.dispose();
    configSub = null;
  }
  if (statusSub) {
    statusSub();
    statusSub = null;
  }
  // Wait for any in-flight reconfigure to settle before closing the watches,
  // so we don't leak one opened by a racing run.
  await reconfiguring;
  for (const dir of watchedDirs()) await takeWatch(dir)?.stop();
}

function sameDirs(a: readonly UserPath[], b: readonly UserPath[]): boolean {
  return a.length === b.length && a.every((dir) => b.includes(dir));
}
