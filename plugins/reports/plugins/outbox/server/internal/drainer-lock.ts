import {
  flockRelease,
  flockTry,
  waitForFlock,
} from "@plugins/packages/plugins/flock/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";

/** The lock file, inside the outbox (never an entry or temp name). */
export const DRAINER_LOCK_NAME = "drainer.lock";

/**
 * The outbox's one-reader rule, held by the kernel rather than inferred from
 * `isMain()`.
 *
 * `isMain()` names a checkout, not a process: across a deploy of main there are
 * TWO main backends — the successor is ready and serving before the gateway
 * stops the old one, which keeps draining until its shutdown hooks run. Both
 * listed the same entry, both recorded it, and the slower one's `unlink` hit
 * ENOENT (the `report-outbox` crash reports of 2026-11-04, each 6–17 s after a
 * main boot). An exclusive flock is owned by one process and released when it
 * dies, by any means — so whoever holds it is the drainer, and nobody else is.
 *
 * The wait is push-based (`waitForFlock`'s child is woken by the kernel when
 * the holder lets go). Once granted, the child's lock is traded for one on our
 * own fd — a lock held through a child costs a process for main's whole life.
 * The trade leaves a gap in which another process could take it; then we wait
 * again (only another main backend ever asks).
 */
export async function acquireDrainerLock(
  path: AppPath,
  signal: AbortSignal,
): Promise<OwnedFd> {
  for (;;) {
    signal.throwIfAborted();
    // "a": create without truncating — the lock file's content is never read.
    const fd = await openOwnedFd(path, "a");
    if (flockTry(fd.fd)) return fd;
    fd.close();
    const held = await waitForFlock(path, { signal });
    await held.release();
  }
}

export function releaseDrainerLock(fd: OwnedFd): void {
  flockRelease(fd.fd);
  fd.close();
}
