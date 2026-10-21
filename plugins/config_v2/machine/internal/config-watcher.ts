import { mkdir } from "node:fs/promises";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { notifyConfigDirChange } from "@plugins/config_v2/server";
import { CONFIG_DIR } from "./config-dir";
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
// the fingerprint-memoized conflict derivation in the server half's
// resource.ts), so a missed
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

// Settles once the watcher is live (or failed to start). The registry answers
// reads from `onReadyBlocking`, but the watcher is armed later, in `onReady`:
// an out-of-band write in between produces no event. A reader whose loader
// already answered awaits this and re-reads once, which closes that window.
// Waiters are held as callbacks rather than one shared promise, so a start
// failure nobody is waiting on is not also an unhandled rejection (it already
// throws out of `onReady`).
type ArmedState =
  | {
      kind: "pending";
      waiters: { resolve: () => void; reject: (e: unknown) => void }[];
    }
  | { kind: "armed" }
  | { kind: "failed"; error: unknown };
let armedState: ArmedState = { kind: "pending", waiters: [] };

function settleArmed(
  next: { kind: "armed" } | { kind: "failed"; error: unknown },
): void {
  const prev = armedState;
  armedState = next;
  if (prev.kind !== "pending") return;
  for (const w of prev.waiters) {
    if (next.kind === "armed") w.resolve();
    else w.reject(next.error);
  }
}

/**
 * Resolves once the config-files watcher is live — from then on every
 * user-layer change produces a `watchFileChange` / `onConfigDirChange` event.
 * Rejects when the watcher failed to start. The file store's `armed` (read
 * through the server half's `configWatcherArmed`).
 */
export function configFilesWatcherArmed(): Promise<void> {
  const state = armedState;
  if (state.kind === "armed") return Promise.resolve();
  if (state.kind === "failed") return Promise.reject(state.error);
  return new Promise((resolve, reject) => {
    state.waiters.push({ resolve, reject });
  });
}

export async function initConfigWatcher(): Promise<void> {
  try {
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
  } catch (err) {
    settleArmed({ kind: "failed", error: err });
    throw err;
  }
  settleArmed({ kind: "armed" });
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
