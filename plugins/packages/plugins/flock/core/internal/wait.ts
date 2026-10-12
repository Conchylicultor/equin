import { join } from "node:path";

/**
 * A lock this process holds — either on one of its own fds or through a
 * `flock-wait` child that holds it on our behalf. Either way the kernel drops it
 * when this process dies: an fd closes with the process, and the child sees its
 * stdin hit EOF and exits.
 */
export interface HeldFlock {
  /**
   * The SYNCHRONOUS half of `release()`: the instant this returns the lock is
   * free host-wide (the fd is closed, or the holding child has been signalled —
   * flock releases on process death, so what is left is only the reap).
   * Exists for callers that cannot await (an `AbortSignal` listener).
   * Idempotent.
   */
  releaseSync(): void;
  /** `releaseSync()`, then reap the holding child if there is one. Idempotent. */
  release(): Promise<void>;
}

export interface WaitForFlockOptions {
  /**
   * Stop waiting. An abort while the wait is pending kills the waiting child,
   * reaps it, and the call THROWS `signal.reason` (the standard `AbortSignal`
   * contract). A grant that lands in the same turn as the abort is handed back
   * and the call throws too — a cancelled caller never receives a lock it would
   * have to remember to release.
   *
   * Only the WAIT is cancellable: once the call has returned, the lock's lifetime
   * is the caller's (`release()`), and a later abort of the same signal does
   * nothing to it.
   */
  signal?: AbortSignal;
}

const FLOCK_WAIT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "flock-wait.ts",
);

const GRANTED = "granted\n";

// One `flock-wait` child that blocks (off our event loop, on a worker thread of
// its own) on ONE lock file and writes "granted\n" once it holds it. `--smol`
// halves RSS (37 MB vs 76 MB).
//
// Module-level on purpose: `WaitChild` is derived from *this* function's return
// type, so the literal `stdin: "pipe"` / `stdout: "pipe"` options narrow `stdin`
// to a `FileSink` and `stdout` to a `ReadableStream`. A bare
// `ReturnType<typeof Bun.spawn>` widens both to `number | ... | undefined`.
//
// `stdin` stays an open pipe for the child's whole life on purpose: it is the
// release channel. The child holds the lock until its stdin hits EOF — which
// happens when WE die, by any means, SIGKILL included — so a lock held through
// a child can never outlive the process it was taken for.
function spawnWait(file: string) {
  return Bun.spawn([process.execPath, "--smol", FLOCK_WAIT_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, FLOCK_WAIT_FILE: file },
  });
}

type WaitChild = ReturnType<typeof spawnWait>;

/**
 * Wait — push-based, without blocking the event loop — until the exclusive
 * `flock` on `path` can be taken, and return it held.
 *
 * `flockTry` is the only acquire that may run on an event loop (a synchronous
 * FFI `flock(LOCK_EX)` freezes the thread it runs on), so the blocking call runs
 * in a `flock-wait` child (`scripts/flock-wait.ts`), on a worker thread of that
 * child so its main thread stays free to notice its parent dying. The child
 * relays `granted` and then HOLDS the lock until released. No polling: the wait
 * is woken by the kernel granting the lock, including when the previous holder
 * dies by SIGKILL.
 *
 * The lock file (and its directory) are created if missing. A child that exits
 * without granting is a loud throw — never a silently-skipped lock.
 *
 * Cost: one `bun --smol` process (~37 MB) per pending wait. Cheap next to the
 * work a caller waits for (a check run, a build); not something to fan out by
 * the thousand.
 */
export async function waitForFlock(
  path: string,
  opts: WaitForFlockOptions = {},
): Promise<HeldFlock> {
  const { signal } = opts;
  // First line: a caller that has already been told to stop never spawns.
  signal?.throwIfAborted();
  const child = spawnWait(path);

  // Cancellation is expressed as KILLING OUR OWN CHILD, never as a
  // `Promise.race` against the signal. Racing would abandon a pending
  // `reader.read()` whose later rejection has no owner — a floating rejection on
  // exactly the path being made safe. A dead child closes its stdout instead, so
  // the read completes normally (as EOF) and unwinds through the code below.
  const onAbort = (): void => {
    child.kill(9);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await awaitGranted(child.stdout, path);
  } catch (err) {
    // Reap before reporting: an unreaped child is a zombie, and a live one
    // could still be parked on the lock.
    child.kill(9);
    await child.exited;
    signal?.throwIfAborted(); // our own kill caused this EOF — report the abort
    throw err;
  } finally {
    // Removed unconditionally: once the call returns, the lock's lifetime is
    // the caller's, and a later abort must not kill a child that now HOLDS it.
    signal?.removeEventListener("abort", onAbort);
  }
  const held = childHold(child);
  if (signal?.aborted) {
    // Granted in the same turn as the abort: do not hand a lock to a caller
    // that has stopped running.
    await held.release();
    signal.throwIfAborted();
  }
  return held;
}

/** The `HeldFlock` for a lock a granted `flock-wait` child holds. */
function childHold(child: WaitChild): HeldFlock {
  let released = false;
  const releaseSync = (): void => {
    if (released) return;
    released = true;
    // SIGTERM: the child's handler exits, closing its fd, which releases the
    // lock. (Its stdin EOF would do the same; the signal does not depend on the
    // pipe still being writable.)
    child.kill();
  };
  return {
    releaseSync,
    release: async () => {
      releaseSync();
      // Awaiting a settled `exited` is a no-op, so a second call stays idempotent.
      await child.exited;
    },
  };
}

/**
 * Read `stream` until the literal `"granted\n"` token appears (the child holds
 * its lock). Async — the event loop is never blocked. If the stream closes
 * without the token, the child died before acquiring → throw loudly.
 */
async function awaitGranted(
  stream: ReadableStream<Uint8Array>,
  path: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(GRANTED)) return;
      if (done) {
        throw new Error(
          `waitForFlock(${path}): flock-wait child exited before granting the lock ` +
            `(stdout closed without "granted")`,
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}
