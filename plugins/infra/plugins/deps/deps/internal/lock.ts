import { mkdirSync, openSync } from "node:fs";
import { adoptFd, type OwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import { flockTry } from "@plugins/packages/plugins/flock/core";

/**
 * The host-wide lock of one `(id, identity)`: a kernel flock on a file, so it
 * is released when its holder closes the fd OR dies (SIGKILL included), and no
 * pid is ever consulted.
 */

/** Take the lock without waiting: its held descriptor, or `null` when another holds it. */
export function tryLock(path: string): OwnedFd | null {
  mkdirSync(dirname(path), { recursive: true });
  const owned = adoptFd(openSync(path, "a"));
  if (flockTry(owned.fd)) return owned;
  owned.close();
  return null;
}

/** Release a lock taken with {@link tryLock} / {@link waitLock}; a second release throws. */
export function releaseLock(lock: OwnedFd): void {
  lock.close();
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
): Promise<OwnedFd> {
  const first = tryLock(path);
  if (first !== null) return first;
  onWait();
  for (;;) {
    await Bun.sleep(LOCK_RETRY_MS);
    const fd = tryLock(path);
    if (fd !== null) return fd;
  }
}

/**
 * Whether some process holds the lock right now. A probe: it takes the lock
 * for the instant of the test and releases it, so a waiter re-trying meanwhile
 * just tries again.
 */
export function isLockHeld(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = adoptFd(openSync(path, "a"));
  try {
    return !flockTry(fd.fd);
  } finally {
    fd.close();
  }
}
