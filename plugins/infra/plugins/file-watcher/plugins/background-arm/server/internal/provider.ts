import { basename } from "node:path";
import type {
  BackgroundEntryDraft,
  BackgroundFact,
} from "@plugins/infra/plugins/background/plugins/catalog/core";
import { defineBackgroundKind } from "@plugins/infra/plugins/background/plugins/catalog/server";
import {
  fileWatcherRecentRuns,
  listFileWatchers,
  type FileWatcherSnapshot,
  type WatcherBackend,
} from "@plugins/infra/plugins/file-watcher/server";

/** At most this many instances are listed one per fact; the rest are counted. */
const WATCHING_FACTS_MAX = 10;

const BACKEND_WORDS: Record<WatcherBackend, string> = {
  "fs-events": "FSEvents",
  kqueue: "kqueue — 1 FD per followed file (and its dir)",
  inotify: "inotify",
  windows: "ReadDirectoryChangesW",
  "platform-default": "@parcel/watcher's default for this platform",
  "fs-watch": "fs.watch — one directory each, its direct entries only",
};

function clock(d: Date, seconds: boolean): string {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

/** A delivery lag in words: ms under a second, else seconds. */
function formatLag(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function facts(w: FileWatcherSnapshot): BackgroundFact[] {
  const out: BackgroundFact[] = [
    {
      label: "Open",
      value:
        w.instances.length > 0 || w.runsHere
          ? String(w.instances.length)
          : "0 — opens only on main",
    },
    { label: "Backend", value: BACKEND_WORDS[w.backend] },
  ];
  for (const i of w.instances.slice(0, WATCHING_FACTS_MAX)) {
    const dirs = i.paths.join(", ");
    out.push({
      label: "Watching",
      value: `${i.label === null ? dirs : `${i.label} — ${dirs}`} · since ${clock(i.openedAt, false)}`,
    });
  }
  if (w.instances.length > WATCHING_FACTS_MAX) {
    out.push({
      label: "Watching",
      value: `…and ${w.instances.length - WATCHING_FACTS_MAX} more`,
    });
  }
  if (w.lastBatch !== null) {
    const b = w.lastBatch;
    const names = b.samplePaths.map((p) => basename(p)).join(", ");
    const more = b.eventCount > b.samplePaths.length ? ", …" : "";
    out.push({
      label: "Last change",
      value: `${b.eventCount} ${b.eventCount === 1 ? "event" : "events"} · ${clock(b.at, true)} · ${names}${more}`,
    });
  }
  if (w.lastDelivery !== null) {
    const d = w.lastDelivery;
    out.push({
      label: "Heard after",
      value:
        d.beforeArm === undefined
          ? `${formatLag(d.lagMs)} — a write to ${basename(d.path)} reached the watch that long after it happened · ${clock(new Date(d.arrivedAt), true)}`
          : `${formatLag(d.lagMs)} after arming — a write to ${basename(d.path)} made before the watch was armed (${formatLag(d.beforeArm.armMs)} from this backend's start to arming${d.beforeArm.beforeStartMs > 0 ? `, ${formatLag(d.beforeArm.beforeStartMs)} before it started` : ""}) · ${clock(new Date(d.arrivedAt), true)}`,
    });
  }
  const folded = w.instances.reduce((n, i) => n + i.foldedBatches, 0);
  if (folded > 0) {
    out.push({
      label: "Folded",
      value: `${folded} ${folded === 1 ? "batch" : "batches"} landed mid-run and joined the one pending run`,
    });
  }
  out.push({
    label: "Runs in",
    value: "This process, in memory — history resets when it restarts",
  });
  return out;
}

/** Every declared file watcher as a catalog entry. */
export function listFileWatcherEntries(): BackgroundEntryDraft[] {
  return listFileWatchers().map((w) => ({
    name: w.name,
    description: w.description,
    group: "File watchers",
    trigger: { kind: "file-change" },
    scope: w.scope,
    runsHere: w.runsHere,
    declaredIn: w.declaredIn,
    lastRun: w.recentRuns[0] ?? null,
    history: {
      runs: w.runs,
      failures: w.failures,
      lastSuccessAt: w.lastSuccessAt?.toISOString() ?? null,
    },
    canRunNow: false,
    internal: false,
    facts: facts(w),
  }));
}

export const fileWatchersBackgroundKind = defineBackgroundKind({
  kind: "file-watcher",
  order: 30,
  label: "File watchers",
  // Watcher state is the in-process registry, never Postgres.
  tables: [],
  list: () => Promise.resolve(listFileWatcherEntries()),
  recentRuns: fileWatcherRecentRuns,
});
