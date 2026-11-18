import { Worker } from "node:worker_threads";
import { scriptPath } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { threadCpuHandle } from "@plugins/packages/plugins/thread-cpu-clock/core";
import { HANG_BEAT_MS, type HangWatchData } from "./hang-judge";

// A check pass can hang in a way its own thread cannot report: on 2026-11-18 a
// build's pass spun one core in a native loop inside bun for 65 minutes, and
// the thread watch (`thread-watch.ts`) — which measures a stall when the late
// tick finally fires — never fired, so nothing was recorded, nothing was
// filed, and the build stayed open until someone killed it by hand. A thread
// cannot notice its own freeze; something outside it must. That is this watch:
// a worker thread of the same process, which needs nothing from the main
// thread but a beat counter and the main thread's CPU clock.
//
// The judgement is `judgeHang` (`hang-judge.ts`): the main thread HELD its core
// `HANG_HELD_MS` without running a timer. The worker then captures the
// evidence, records it, files a `check-pass-hung` report and SIGKILLs the
// process (`scripts/hang-watch-worker.ts`) — so whatever waited on the pass (a
// build, a push, the agent-build gate) gets a failure instead of forever.

const WORKER_SCRIPT =
  "plugins/framework/plugins/tooling/plugins/checks/scripts/hang-watch-worker.ts";

/** A live hang watch; `stop()` ends it (the run finished), idempotent. */
export interface HangWatch {
  stop(): void;
}

/**
 * Open the watch for one check run, from the run's own (main) thread — the
 * clock handle names the CALLING thread. Where the platform has no thread CPU
 * clock there is nothing to judge a hang by, and the watch is not armed.
 */
export function openHangWatch(args: {
  runId: string;
  worktree: string;
  transcript: string | null;
}): HangWatch {
  const thread = threadCpuHandle();
  if (!thread.supported) return { stop: () => {} };
  const beats = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(beats);
  const data: HangWatchData = {
    beats,
    thread,
    pid: process.pid,
    runId: args.runId,
    worktree: args.worktree,
    transcript: args.transcript,
    openedAt: Date.now(),
  };
  const worker = new Worker(scriptPath(WORKER_SCRIPT), { workerData: data });
  // Never the reason the process stays alive: the watch observes the run.
  worker.unref();
  // A watchdog that broke is a check pass running unwatched — loud, not silent.
  worker.on("error", (err) => {
    throw err;
  });
  const beat = setInterval(() => Atomics.add(counter, 0, 1), HANG_BEAT_MS);
  beat.unref();
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(beat);
      void worker.terminate();
    },
  };
}
