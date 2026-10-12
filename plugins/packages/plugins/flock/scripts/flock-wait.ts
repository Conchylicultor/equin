#!/usr/bin/env bun
/**
 * `waitForFlock`'s subprocess — waits for ONE lock file to become holdable and
 * signals its parent, without ever freezing on the blocking flock itself.
 *
 * Spawned by `core/internal/wait.ts` (`waitForFlock`), one per wait: the
 * host-semaphore spawns one per slot during fan-out AND one for the turnstile,
 * single-flight one per joiner. The single lock file to wait on arrives via env
 * (`FLOCK_WAIT_FILE`). Moved here from `packages/host-semaphore/scripts/`.
 *
 * Design — why the flock lives on a WORKER thread, not here:
 *   A synchronous FFI `flock(LOCK_EX)` has no yield point; the thread it runs on is
 *   frozen until the lock frees. If it ran on THIS main thread, an orphaned child
 *   (parent SIGKILLed, so nobody sends SIGTERM) could never observe stdin EOF and
 *   would leak the process — the exact orphan hole the old broker had. So the block
 *   runs on a `node:worker_threads` Worker (`flock-block.ts`) while this main thread
 *   stays responsive to stdin EOF and SIGTERM, guaranteeing the child can always
 *   exit and release its slot. (Measured: EOF-only and SIGTERM both exit cleanly.)
 *
 * Lifecycle:
 *  1. Spawn the worker; it blocks on `flock(LOCK_EX)` and posts "granted".
 *  2. On "granted" → write "granted\n" to stdout (guarding a dead parent).
 *  3. Hold the lock (the worker keeps its fd open) until the parent closes our stdin
 *     (EOF) or sends SIGTERM, then exit. Process exit closes the fd → flock releases.
 *
 * Imports NOTHING cross-plugin (only `node:*` + `bun:ffi` via the worker), so it
 * stays a standalone, independently-runnable script with no boundary concerns.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

const file = process.env.FLOCK_WAIT_FILE;
if (!file) {
  throw new Error(
    "flock-wait: FLOCK_WAIT_FILE must be set to one absolute lock-file path",
  );
}

mkdirSync(dirname(file), { recursive: true });

// The worker does the blocking flock off this main thread. `unref()` so a still-
// blocked worker never keeps our loop alive on its own — the stdin drain below is
// the sole thing keeping us alive, so EOF always wins.
const worker = new Worker(join(import.meta.dir, "flock-block.ts"), {
  workerData: { file },
});
worker.unref();

worker.on("message", () => {
  // The worker holds the lock. Relay the grant. A failed write means the parent
  // died while we waited → exit, which closes the fd and releases the slot. We
  // inspect the error rather than swallow it: a dead-peer write error (EPIPE/EBADF)
  // is the expected race and the right response is to release by exiting; anything
  // else is unexpected and rethrows so it stays loud.
  try {
    process.stdout.write("granted\n");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (
      code === "EPIPE" ||
      code === "EBADF" ||
      code === "ERR_STREAM_DESTROYED"
    ) {
      process.exit(0);
    }
    throw err;
  }
});

// A worker error is unexpected (e.g. dlopen/flock failure) → fail loudly.
worker.on("error", (err) => {
  throw err;
});

// SIGTERM (parent kill) → release by exiting.
process.on("SIGTERM", () => process.exit(0));

// Hold the slot until the parent closes our stdin (EOF). The parent never writes to
// stdin — closing it is the release signal (parent died or called stdin.end()).
// Draining to EOF then exiting closes the fd → flock auto-releases.
for await (const _chunk of Bun.stdin.stream()) {
  // Parent never writes; we only wait for the stream to close.
}
process.exit(0);
