/**
 * The check pass's watchdog thread (`core/hang-watch.ts` opens it): every
 * `HANG_POLL_MS` it reads the main thread's beat count and CPU clock, and once
 * `judgeHang` calls the main thread hung — its core HELD `HANG_HELD_MS`
 * without one timer run — it captures the evidence, records it, files a
 * `check-pass-hung` report and SIGKILLs the process.
 *
 * Why here and not on the main thread: the main thread is the one that is
 * stuck. Nothing it would run — a timer, a signal handler, a message — runs.
 * `process.kill` is a plain syscall, legal from any thread (flock's
 * `lifeline-block.ts` kills the same way).
 *
 * While it waits it loads only the judge and the clock; everything the verdict
 * needs is imported when it is reached.
 */
import { workerData } from "node:worker_threads";
import { readThreadCpuOf } from "@plugins/packages/plugins/thread-cpu-clock/core";
import {
  createHangJudge,
  HANG_POLL_MS,
  judgeHang,
  type HangWatchData,
} from "../core/hang-judge";

// Typed by annotation, not `as`: a cast here is what no-use-resource-cast
// flags (on Linux, where git grep -E reads `\b`).
const data: HangWatchData = workerData;
const beats = new Int32Array(data.beats);

function mainCpuMs(): number {
  const reading = readThreadCpuOf(data.thread);
  // The handle was taken where the clock exists, in this same process.
  if (!reading.supported)
    throw new Error(
      "hang-watch: the main thread's CPU clock stopped answering",
    );
  return reading.ms;
}

const judge = createHangJudge(Atomics.load(beats, 0), mainCpuMs(), Date.now());

const poll = setInterval(() => {
  const verdict = judgeHang(
    judge,
    Atomics.load(beats, 0),
    mainCpuMs(),
    Date.now(),
  );
  if (verdict.kind !== "hung") return;
  clearInterval(poll);
  void killHung(verdict.heldMs, verdict.silentMs);
}, HANG_POLL_MS);

async function killHung(heldMs: number, silentMs: number): Promise<never> {
  let line: string;
  try {
    const { recordHungRun } = await import("../cli/internal/hung-run");
    line = (await recordHungRun({ ...data, heldMs, silentMs })).consoleLine;
  } catch (err) {
    // The kill below must happen whatever recording did: a hung pass left
    // running because its report failed is the bug this watch exists for. The
    // failure is printed in its place, whole.
    line =
      `✗ check pass hung (main thread held its core ${Math.round(heldMs / 1000)} s without yielding) — ` +
      `killing it; recording the hang FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  }
  // From this thread, awaited: the main thread will never flush a write it
  // queued, and the process ends on the next line. A build captures this as
  // the check step's output.
  await Bun.write(Bun.stderr, `\n${line}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("hang-watch: survived its own SIGKILL");
}
