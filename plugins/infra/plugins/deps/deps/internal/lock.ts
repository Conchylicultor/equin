import { mkdir, open, type FileHandle } from "node:fs/promises";
import { exists } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";

/**
 * The host-wide lock of one `(id, identity)`: a kernel flock on a file, so it
 * is released when its holder closes the fd OR dies (SIGKILL included), and no
 * pid is ever consulted.
 */

/**
 * A held lock: the open file the flock sits on. Its handle owns the
 * descriptor, so it closes exactly once, through {@link releaseLock}.
 */
export type HeldLock = FileHandle;

// A flock is per open file, so this process's own probe (`isLockHeld`), which
// takes the lock for a moment and releases it across an `await`, is seen by
// another in-process attempt as a holder: two overlapping state reads would
// make the second answer "installing", a remove racing a read answer busy.
// Every momentary take — a probe, and an attempt from open to its verdict — is
// serialized per lock path, so an in-process attempt never observes a probe.
// A lock actually TAKEN outlives its section, and is rightly seen as held.
const attemptMutex = createKeyedMutex();

/** Take the lock without waiting: its held descriptor, or `null` when another holds it. */
export async function tryLock(path: string): Promise<HeldLock | null> {
  await mkdir(dirname(path), { recursive: true });
  return attemptMutex.run(path, async () => {
    const handle = await open(path, "a");
    if (flockTry(handle.fd)) return handle;
    await handle.close();
    return null;
  });
}

/** Release a lock taken with {@link tryLock} / {@link waitLock}. */
export async function releaseLock(lock: HeldLock): Promise<void> {
  await lock.close();
}

/** How long to wait between two tries while another process installs. */
const LOCK_RETRY_MS = 500;

/**
 * Take the lock, waiting for its holder to finish.
 *
 * Only ever called from an out-of-process context (`ensureDep` demands an
 * `ExecContext`), never on a backend's event loop. `flockTry` is non-blocking
 * by design — a blocking `flock` has no yield point — so the wait re-tries it,
 * as the song index's snapshot lock does. The holder is installing something
 * that takes minutes; a half-second re-try is invisible next to it, and there
 * is no change signal to wait on short of the blocking call itself.
 */
export async function waitLock(
  path: string,
  onWait: () => void,
): Promise<HeldLock> {
  const first = await tryLock(path);
  if (first !== null) return first;
  onWait();
  for (;;) {
    await Bun.sleep(LOCK_RETRY_MS);
    const fd = await tryLock(path);
    if (fd !== null) return fd;
  }
}

/**
 * Whether some process holds the lock right now. A probe: it takes the lock
 * for the instant of the test and releases it, so a waiter re-trying meanwhile
 * just tries again.
 */
export async function isLockHeld(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  return attemptMutex.run(path, async () => {
    const handle = await open(path, "a");
    try {
      return !flockTry(handle.fd);
    } finally {
      await handle.close();
    }
  });
}
