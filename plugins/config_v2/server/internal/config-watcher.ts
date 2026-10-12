import { mkdir } from "node:fs/promises";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { CONFIG_DIR } from "./config-dir";
import { notifyConfigDirChange } from "./config-dir-change";
import type { Disposable } from "../../core";

// No reconcile (no `reconcileMs`, so no timer). One re-fired EVERY watched
// path (2 per descriptor), each re-reading from disk and re-running a full
// conflicts recompute, producing an O(N²) idle I/O storm with nothing
// changed.
//
// These events are therefore a PUSH-LATENCY mechanism, not a correctness one:
// config files normally change in-process (setConfig / fork) or via
// ./singularity build propagation and parcel fires on every disk write
// regardless of writer, but an event can still be missed (an out-of-band
// writer parcel doesn't see, a dropped fsevent). Nothing downstream may treat
// "no event" as "no change" — derived state must be founded on the disk (see
// the fingerprint-memoized conflict derivation in resource.ts), so a missed
// event can only delay a push, never leave a wrong value behind.
export const configFilesWatcher = defineFileWatcher({
  name: "config_v2.config-files",
  description:
    "Watches the config directory's .jsonc files and reloads a config the moment its file changes on disk.",
  extensions: [".jsonc"],
});

const watchers = new Map<string, Set<() => void>>();
let watcher: FileWatcher | null = null;

function notifyWatchers(abs: string): void {
  const cbs = watchers.get(abs);
  if (!cbs || cbs.size === 0) return;
  for (const cb of cbs) cb();
}

export async function initConfigWatcher(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });

  watcher = await configFilesWatcher.start({
    dirs: [CONFIG_DIR],
    onChange: (events) => {
      const paths = new Set(events.map((e) => e.path));
      for (const p of paths) {
        if (watchers.has(p)) notifyWatchers(p);
      }
      if (events.length > 0) notifyConfigDirChange();
    },
  });
}

export async function shutdownConfigWatcher(): Promise<void> {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
}

export function watchFileChange(absPath: string, cb: () => void): Disposable {
  let cbs = watchers.get(absPath);
  if (!cbs) {
    cbs = new Set();
    watchers.set(absPath, cbs);
  }
  cbs.add(cb);

  return {
    dispose: () => {
      cbs!.delete(cb);
      if (cbs!.size === 0) {
        watchers.delete(absPath);
      }
    },
  };
}
