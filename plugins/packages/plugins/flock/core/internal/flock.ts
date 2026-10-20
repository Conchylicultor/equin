import { dlopen } from "bun:ffi";

// `flock(2)` operations, from <sys/file.h>. Identical on darwin and linux.
const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/**
 * libc's `flock`, dlopen'd LAZILY on first use rather than at module eval.
 *
 * Two reasons, both load-bearing. (1) This module is reachable from the CLI
 * bootstrap (`bin/index.ts` → `ensure-deps.ts` → `checkout-lock.ts`), and every
 * `./singularity <anything>` would otherwise pay a dlopen before its first
 * statement. (2) It keeps the module importable in non-FFI contexts — type-only
 * consumers, tooling, a docgen pass — which a module-eval dlopen would break.
 */
let flockFn: ((fd: number, op: number) => number) | null = null;

function flock(fd: number, op: number): number {
  if (flockFn === null) {
    const { symbols } = dlopen(
      process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
      { flock: { args: ["i32", "i32"], returns: "i32" } },
    );
    flockFn = symbols.flock as (fd: number, op: number) => number;
  }
  return flockFn(fd, op);
}

/**
 * Try to take the exclusive lock on `fd` WITHOUT blocking. `true` iff this
 * process now holds it. `false` is "not acquired" — in practice always
 * EWOULDBLOCK (someone else holds it), since the other errno cases (EBADF,
 * EINVAL) mean the caller handed over a broken fd. Bun's dlopen surfaces no
 * errno, so the two are not distinguishable here; callers turn a persistent
 * `false` into a loud timeout rather than waiting forever.
 *
 * Non-blocking on purpose, and the only acquire this primitive offers: a
 * synchronous FFI `flock(LOCK_EX)` has no yield point, so it freezes the thread
 * it runs on until the lock frees — never acceptable on an event loop. Callers
 * that must *wait* poll this, or (host-semaphore) push the blocking wait onto a
 * worker thread.
 *
 * The lock is owned by the open file description, so it is released by
 * `flockRelease` OR by closing the fd OR **by the process dying** — SIGKILL,
 * OOM and power loss included. That last clause is the whole point: it is the
 * only lock ownership in this codebase that cannot be left stale by a process
 * that never got to run cleanup, and it is immune to PID reuse because no pid is
 * ever consulted.
 */
export function flockTry(fd: number): boolean {
  return flock(fd, LOCK_EX | LOCK_NB) === 0;
}

/**
 * Try to take a SHARED lock on `fd` without blocking — `flockTry`'s twin for
 * a lock many holders may share at once. `true` iff this process now holds it;
 * `false` means an exclusive holder has it. Any number of shared holders
 * coexist, and an exclusive acquire is granted only once none is left — which
 * is how a set of holders can announce "some of us are here" to a waiter that
 * takes the exclusive lock to learn "nobody is" (host-semaphore's demand gate).
 */
export function flockTryShared(fd: number): boolean {
  return flock(fd, LOCK_SH | LOCK_NB) === 0;
}

/**
 * Drop the lock held on `fd`, keeping the fd open. Closing the fd releases it
 * too, so this is only for holders that outlive their own lock.
 */
export function flockRelease(fd: number): void {
  flock(fd, LOCK_UN);
}
