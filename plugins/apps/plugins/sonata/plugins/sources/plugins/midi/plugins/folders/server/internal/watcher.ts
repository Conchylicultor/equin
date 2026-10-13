import {
  defineFileWatcher,
  type FileChangeEvent,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { watchConfig } from "@plugins/config_v2/server";
import type { Disposable } from "@plugins/config_v2/core";
import {
  getSongMidiBySourcePath,
  setSourceMissing,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server";
import { midiFoldersConfig } from "../../shared/config";
import { importMidiFileJob } from "./import-job";
import { reconcile, watchedDirsSync } from "./reconcile";

/**
 * One instance over the configured folders, re-opened (stop + start) whenever
 * the folder list changes.
 */
export const midiFoldersWatcher = defineFileWatcher({
  name: "sonata-midi-folders.folders",
  description:
    "Watches your MIDI folders: imports a .mid file when it is added or edited and badges its song when the file is deleted.",
  extensions: [".mid", ".midi"],
  // A backstop for a dropped fsevent: re-derives the whole folder set.
  reconcileMs: 30_000,
});

// Mirrors infra/git/git-watcher's manager: module-level mutable watcher, `started`
// guard, async start/stop. The watcher set is rebuilt whenever the configured
// folder list changes (via watchConfig) — config_v2 drives the dir set, so
// there is no polling.
let watcher: FileWatcher | null = null;
let configSub: Disposable | null = null;
let started = false;

// Serialize reconfigure runs: overlapping config changes (or a config change
// racing the immediate-on-register call) must not create two live watchers.
let reconfiguring: Promise<void> = Promise.resolve();

async function onChange(events: FileChangeEvent[]): Promise<void> {
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

// Tear down the current watcher and mount a fresh one over the configured dirs.
// The immediate (boot) call mounts the watcher ONLY — the heavy walk is deferred
// to `midiFoldersWarmup`. A genuine later config-change (`{ reconcile: true }`)
// still reconciles inline: it picks up files added while a folder was unmounted /
// in a newly added folder, and it is user-initiated, not boot work. The watcher
// emits no events for pre-existing files, so reconcile is mandatory on a real
// config change.
async function reconfigure(opts: { reconcile: boolean }): Promise<void> {
  // Chain onto the previous run so two config changes can't race two watchers.
  reconfiguring = reconfiguring.then(async () => {
    if (watcher) {
      await watcher.stop();
      watcher = null;
    }
    const dirs = watchedDirsSync();
    if (dirs.length > 0) {
      watcher = await midiFoldersWatcher.start({
        dirs,
        onChange: (events) =>
          runTracked("midi-folders:change", () => onChange(events)),
        onReconcile: () =>
          runTracked("midi-folders:reconcile", () => reconcile()),
      });
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
  // Wait for any in-flight reconfigure to settle before tearing the watcher
  // down, so we don't leak a watcher created by a racing run.
  await reconfiguring;
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
}
