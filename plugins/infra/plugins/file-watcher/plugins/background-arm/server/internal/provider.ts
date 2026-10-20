import { basename } from "node:path";
import type {
  BackgroundEntryDraft,
  BackgroundFact,
} from "@plugins/infra/plugins/background/plugins/catalog/core";
import { defineBackgroundKind } from "@plugins/infra/plugins/background/plugins/catalog/server";
import {
  WRITES_WHILE_OPEN_MAX_ENTRIES,
  fileWatcherRecentRuns,
  listFileWatchers,
  type FileWatcherSnapshot,
  type WatcherBackend,
} from "@plugins/infra/plugins/file-watcher/server";

/** At most this many instances are listed one per fact; the rest are counted. */
const WATCHING_FACTS_MAX = 10;

const BACKEND_WORDS: Record<WatcherBackend, string> = {
  "fs-events": "FSEvents",
  kqueue: `kqueue — 1 FD per file, capped at ${WRITES_WHILE_OPEN_MAX_ENTRIES.toLocaleString("en-US")} entries`,
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
    const dirs = i.dirs.join(", ");
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
  const folded = w.instances.reduce((n, i) => n + i.foldedBatches, 0);
  if (folded > 0) {
    out.push({
      label: "Folded",
      value: `${folded} ${folded === 1 ? "batch" : "batches"} landed mid-run and joined the one pending run`,
    });
  }
  if (w.reconcileMs !== null) {
    out.push({
      label: "Reconcile",
      value: `Every ${Math.round(w.reconcileMs / 1000)} s`,
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
