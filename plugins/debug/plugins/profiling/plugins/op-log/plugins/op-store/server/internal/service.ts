import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { db } from "@plugins/database/server";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
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
// on every change in the op-log directory, when the watch reports dropped
// events, and (main only) on the dead-op sweep below.

const LOG_NAME = basename(OP_LOG_FILE);

export const opLogWatcher = defineFileWatcher({
  name: "op-store.op-log",
  description:
    "Watches the host-global op log and its rotations and ingests new op lines into this backend's op table, re-draining the whole log when the watch reports dropped events.",
});

// A SIGKILLed op writes no terminal and leaves no filesystem event: its marker
// simply stops being locked, which only a look can tell. So on MAIN a timer
// looks — main is the one backend that closes such an op, by appending a
// reconciler terminal to the log, which every other backend then hears as an
// ordinary log change. (A worktree closes a row itself only after an ingest
// gap, which it finds on the drain.) One sweep host-wide, not one per backend.
export const deadOpSweepTimer = defineTimer({
  name: "op-store.dead-op-sweep",
  description:
    "Closes in-flight ops whose process died without logging its end (a hard kill leaves no file event to react to), by appending their terminal to the op log.",
  everyMs: 30_000,
  mainOnly: true,
  run: () => passes.run(),
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
  // judge a half-applied state, so leave the pass to it (it reconciles after
  // its drain).
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
    onLost: () => passes.run(),
  });
  passes.trigger();
  if (isMain()) deadOpSweepTimer.start();
}

export async function stopOpStore(): Promise<void> {
  if (!watcher) return;
  deadOpSweepTimer.stop();
  await watcher.stop();
  watcher = null;
}
