/**
 * `flock-wait.ts`'s worker body — the one place a *blocking* `flock(LOCK_EX)` runs
 * (`lifeline-block.ts` blocks on a SHARED lock, for a different purpose).
 *
 * Runs as a `node:worker_threads` Worker spawned by `flock-wait.ts`. It opens one
 * lock file (path in `workerData.file`), blocks on `flock(fd, LOCK_EX)`, and posts
 * `"granted"` back to the parent once it holds the lock.
 *
 * Why a worker thread and not the main thread? A synchronous FFI `flock(LOCK_EX)`
 * has no yield point — the thread it runs on cannot observe stdin EOF or run signal
 * handlers while parked. If the blocking flock ran on `flock-wait.ts`'s MAIN thread
 * and that process were orphaned (its parent SIGKILLed, so nobody is left to send
 * SIGTERM), it could never see stdin close and would leak forever. Parking the block
 * on a *worker* thread keeps the child's main thread responsive to EOF and signals,
 * so the child can always exit and release. See the plan's orphan case.
 *
 * The fd is process-wide, so we deliberately never close it: process exit closes it
 * and the flock auto-releases. Holding it open here is what keeps the slot held.
 *
 * Imports nothing cross-plugin (only `node:*` + `bun:ffi`).
 */
import { openSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { dlopen } from "bun:ffi";

const { file, shared } = workerData as { file: string; shared?: boolean };
if (typeof file !== "string" || file.length === 0) {
  throw new Error("flock-block: workerData.file must be a non-empty string");
}
if (!parentPort) {
  throw new Error("flock-block: must run as a worker thread (no parentPort)");
}

const { symbols: ffi } = dlopen(
  process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
  { flock: { args: ["i32", "i32"], returns: "i32" } },
);
const LOCK_SH = 1;
const LOCK_EX = 2;
const op = shared === true ? LOCK_SH : LOCK_EX;

// Open (never close) the lock fd, then block THIS thread only until we hold it.
const fd = openSync(file, "w");
const rc = ffi.flock(fd, op);
if (rc !== 0) {
  // Fail loudly — a non-zero flock is unexpected for a plain blocking flock.
  throw new Error(
    `flock-block: flock(${shared === true ? "LOCK_SH" : "LOCK_EX"}) on ${file} returned ${rc}`,
  );
}

// We hold the lock. Tell the main thread; it relays "granted\n" to the parent.
parentPort.postMessage("granted");
