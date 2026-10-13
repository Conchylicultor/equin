import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { db } from "@plugins/database/server";
import {
  appendOpLog,
  OP_LOG_FILE,
} from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { drainOpLog, type DrainResult } from "./ingest";
import { isOpLive, reconcileOps } from "./reconcile";

// The op store's lifecycle on one serving backend: one serialized PASS —
// drain the log into this DB, then reconcile dead in-flight rows — run at boot,
// on every change in the op-log directory, and on a 30 s backstop tick (a
// SIGKILL leaves no filesystem event; the tick is what notices the dead pid).

const LOG_NAME = basename(OP_LOG_FILE);

export const opLogWatcher = defineFileWatcher({
  name: "op-store.op-log",
  description:
    "Watches the host-global op log and its rotations and ingests new op lines into this backend's op table, re-draining every 30 seconds in case an event was missed.",
  reconcileMs: 30_000,
});

let watcher: FileWatcher | null = null;
// Passes are serialized: two overlapping drains would both plan from the same
// cursor. A change landing mid-pass is owed one more pass. A failed pass is
// unexpected and surfaces as an unhandled rejection, without disarming later
// passes.
const passes = createCoalescer({
  run: () => runTracked("op-store:pass", pass),
});

async function pass(): Promise<void> {
  const drained: DrainResult = await drainOpLog({ db, path: OP_LOG_FILE });
  if (drained.kind === "moved") {
    // Another process advanced this DB's cursor between our read and our
    // commit (a hot-swap overlap). Re-plan from where it left it.
    passes.trigger();
    return;
  }
  // `busy`: another process holds the ingest lock and is draining this DB
  // right now; reconciling against rows it is mid-way through writing would
  // judge a half-applied state, so leave the pass to it (the tick retries).
  if (drained.kind === "busy") return;
  await reconcileOps({
    db,
    main: isMain(),
    isLive: isOpLive,
    append: appendOpLog,
  });
}

/**
 * Boot: drain → reconcile (awaited, so the boot-preloaded in-flight rows are
 * current as soon as possible), then watch. A write that lands between the
 * first pass and the subscription is picked up by the pass scheduled right
 * after subscribing.
 */
export async function startOpStore(): Promise<void> {
  if (watcher) return;
  await passes.run();
  const dir = dirname(OP_LOG_FILE);
  mkdirSync(dir, { recursive: true });
  watcher = await opLogWatcher.start({
    dirs: [dir],
    onChange: (events) => {
      // `op-log.jsonl` and its rotations; anything else in the dir is not ours.
      return events.some((e) => basename(e.path).startsWith(LOG_NAME))
        ? passes.run()
        : undefined;
    },
    onReconcile: () => passes.run(),
  });
  passes.trigger();
}

export async function stopOpStore(): Promise<void> {
  if (!watcher) return;
  await watcher.stop();
  watcher = null;
}
