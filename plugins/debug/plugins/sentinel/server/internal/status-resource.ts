import { basename } from "node:path";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import {
  duressLatchDir,
  LATCH_FILENAME,
  readFreshDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  sentinelStatus,
  sentinelVitals,
  type SentinelStatusValue,
  type SentinelVitals,
} from "../../core";
import {
  diskAlarmOf,
  type DiskAlarm,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import {
  readSentinelVitals,
  readSentinelWatch,
  isStatusFilename,
  sentinelStatusDir,
  VITALS_FILENAME,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/server";

// `sentinel.status` and `sentinel.vitals` on EVERY backend, not just main: the
// watcher runs only in main, but an agent mostly looks at its own worktree's
// health report. Every backend serves the host-global files main's watcher
// writes, and pushes when a file changes — the file-watcher primitive, no
// polling. External, not DB-backed, so the served values carry `notify()`.
//
// The pid-liveness half of the status is computed at read time, so a main that
// died without writing `stopped` reads as not running the next time anything
// reads the file (a subscribe, a reconnect, any later write).

export function readStatusValue(): SentinelStatusValue {
  const latch = readFreshDuress();
  return {
    watch: readSentinelWatch(sentinelStatusDir.path),
    duress: latch === null ? null : { since: latch.setAt },
    disk: diskAlarmFrom(readVitalsValue()),
  };
}

/** The disk verdict of a reading, when it is the running watcher's and has one. */
export function diskAlarmFrom(vitals: SentinelVitals): DiskAlarm | null {
  if (vitals.kind !== "recorded" || !vitals.current) return null;
  const { disk } = vitals.vitals.context;
  return disk === null ? null : diskAlarmOf(disk);
}

export const sentinelStatusServed = serveValue(sentinelStatus, {
  source: "external",
  changes: "notified",
  loader: () => readStatusValue(),
});

/**
 * The latest reading, marked `current` only when the status file names its
 * writer as the watcher running now (same pid, still alive).
 */
export function readVitalsValue(
  dir: string = sentinelStatusDir.path,
  alive?: (pid: number) => boolean,
): SentinelVitals {
  const read = readSentinelVitals(dir);
  if (read.kind !== "recorded") return read;
  const watch = readSentinelWatch(dir, alive);
  const current =
    watch.kind === "recorded" &&
    watch.ownerAlive &&
    watch.status.state === "running" &&
    watch.pid === read.vitals.pid;
  return { kind: "recorded", vitals: read.vitals, current };
}

// A zero-argument wrapper: `readVitalsValue`'s optional parameters are test
// seams, and the loader is handed the (empty) params tuple.
export const sentinelVitalsServed = serveValue(sentinelVitals, {
  source: "external",
  changes: "notified",
  loader: () => readVitalsValue(),
});

/**
 * Which resources a changed file feeds. Routed by name so the per-tick vitals
 * write (every 5 s) does not re-push the status to every tab — only a change of
 * its disk verdict does (`startStatusWatcher`).
 */
export function resourcesForFile(path: string): {
  status: boolean;
  vitals: boolean;
} {
  const name = basename(path);
  // `current` on the vitals value is read against the status files.
  if (isStatusFilename(name)) return { status: true, vitals: true };
  switch (name) {
    case VITALS_FILENAME:
      return { status: false, vitals: true };
    case LATCH_FILENAME:
      return { status: true, vitals: false };
    default:
      return { status: false, vitals: false };
  }
}

export const sentinelStatusWatcher = defineFileWatcher({
  name: "sentinel.status",
  description:
    "Watches the host-global sentinel status, vitals and duress-latch files and pushes the sentinel status and vitals values when one of them is rewritten.",
  extensions: [".json", ".latch"],
});

let watcher: FileWatcher | null = null;

/**
 * The disk verdict last pushed with the status. A vitals write (every tick)
 * re-pushes the status only when it moves the verdict, so tabs hear about a
 * filling disk without a 5 s stream of identical statuses.
 */
let lastDiskAlarm: DiskAlarm | null | undefined;

export async function startStatusWatcher(): Promise<void> {
  if (watcher) return;
  // Subscribing to a missing directory fails; both dirs are host-global and cheap.
  const statusDir = sentinelStatusDir.ensure();
  const latchDir = duressLatchDir.ensure();
  watcher = await sentinelStatusWatcher.start({
    dirs: [statusDir, latchDir],
    onChange: (events) => {
      let status = false;
      let vitals = false;
      for (const event of events) {
        const hit = resourcesForFile(event.path);
        status ||= hit.status;
        vitals ||= hit.vitals;
      }
      if (status || vitals) {
        const disk = diskAlarmFrom(readVitalsValue());
        status ||= disk !== lastDiskAlarm;
        lastDiskAlarm = disk;
      }
      if (status) sentinelStatusServed.notify();
      if (vitals) sentinelVitalsServed.notify();
    },
  });
}

export async function stopStatusWatcher(): Promise<void> {
  const w = watcher;
  watcher = null;
  await w?.stop();
}
