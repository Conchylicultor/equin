/**
 * `exitWithParent`'s worker-thread body: blocks until the parent's lifeline
 * lock is free, then SIGKILLs this whole process.
 *
 * The parent holds `flock(LOCK_EX)` on the lifeline file for exactly as long as
 * it is alive and waiting on us. The kernel drops that lock when the parent's
 * fd closes — which includes the parent dying by SIGKILL, OOM or a crash, when
 * no cleanup code of its own runs. So our `flock(LOCK_SH)` is granted at the
 * instant the parent is gone, and not before.
 *
 * Why the kill happens HERE and not via a message to the main thread: the
 * process this guards (the type-check worker) spends minutes in one synchronous
 * TypeScript program build. Its main thread would never drain a message, so the
 * orphan would run to completion — which is the bug. `process.kill` is a plain
 * syscall, legal from any thread, whatever the main thread is doing.
 *
 * A missing lifeline file means the same thing as a granted lock: the parent
 * removes it only after this child exited, or never got to create it for us —
 * either way nobody is waiting on our result.
 *
 * Imports nothing cross-plugin (only `node:*` + `bun:ffi`): it is loaded by
 * path as a Worker, like `flock-block.ts`.
 */
import { openSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { dlopen } from "bun:ffi";

const { file } = workerData as { file: string };
if (typeof file !== "string" || file.length === 0) {
  throw new Error("lifeline-block: workerData.file must be a non-empty string");
}

const { symbols: ffi } = dlopen(
  process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
  { flock: { args: ["i32", "i32"], returns: "i32" } },
);
const LOCK_SH = 1;

function parentGone(): never {
  process.kill(process.pid, "SIGKILL");
  // Unreachable: SIGKILL cannot be caught. Keeps the return type honest.
  throw new Error("lifeline-block: survived its own SIGKILL");
}

let fd: number;
try {
  fd = openSync(file, "r");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") parentGone();
  throw err;
}
const rc = ffi.flock(fd, LOCK_SH);
if (rc !== 0) {
  // A plain blocking flock on a valid fd does not fail; if it does, the
  // lifeline is broken and the child must not silently run unguarded.
  throw new Error(`lifeline-block: flock(LOCK_SH) on ${file} returned ${rc}`);
}
parentGone();
