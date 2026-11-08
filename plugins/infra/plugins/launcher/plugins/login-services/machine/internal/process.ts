import { SERVICE_STOP_TIMEOUT_S, SERVICE_STOP_WAIT_MS } from "../../core";

/**
 * Waiting out a stopped service's process — the step between `unload` and the
 * next `load` (`reconcile.ts`), and `./equin stop`'s last word.
 *
 * Here rather than in `infra/launcher`'s `server` barrel (where it was): a
 * machine half may not reach it there without a launcher ↔ login-services
 * import cycle, and a `server/` file may not import this `machine` barrel —
 * so the liveness probe is this file's own, the launcher keeping `isRunning`
 * for its pidfile reads.
 */

/** Whether `pid` names a live process (EPERM: it exists, we just may not signal it). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw err;
  }
}

/**
 * Wait for a stopped process to be gone. Throws if it outlives
 * {@link SERVICE_STOP_WAIT_MS} — past the stop timeout its manager kills at
 * (launchd's ExitTimeOut, systemd's TimeoutStopSec), so a process alive then
 * survived SIGKILL.
 *
 * Derived from that timeout rather than its own literal: the wait used to be
 * 20 s, the same as ExitTimeOut, so a slow stop was a race between this
 * giving up and launchd's kill landing (2026-11-08: `start --force` lost it).
 *
 * A stop must be observed, not assumed: a fixed sleep let an old gateway keep
 * tearing down its backends while the new one booted and ran its orphan
 * reconcile — overlapping generations, the routine trigger for orphaned
 * backends. A process exit has no event a non-parent can wait on, so this is a
 * bounded wait on the one fact that matters, not a change watch.
 */
export async function awaitProcessGone(
  pid: number,
  budgetMs: number = SERVICE_STOP_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (processExists(pid) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (processExists(pid)) {
    throw new Error(
      `Process ${pid} is still running ${budgetMs / 1000}s after being stopped; refusing to carry on as if it were gone.`,
    );
  }
}

/**
 * Stop a process no service manager owns the way a manager would: SIGTERM,
 * SIGKILL once {@link SERVICE_STOP_TIMEOUT_S} has passed, then
 * {@link awaitProcessGone | wait for it to be gone} — so a gateway started
 * detached gets the same stop budget, and the same certain end, as one under
 * launchd.
 */
export async function terminateProcess(pid: number): Promise<void> {
  if (!signal(pid, "SIGTERM")) return;
  const killAt = Date.now() + SERVICE_STOP_TIMEOUT_S * 1000;
  while (processExists(pid) && Date.now() < killAt) {
    await Bun.sleep(100);
  }
  if (processExists(pid)) signal(pid, "SIGKILL");
  await awaitProcessGone(
    pid,
    SERVICE_STOP_WAIT_MS - SERVICE_STOP_TIMEOUT_S * 1000,
  );
}

/** Signal `pid`; false when it had already exited. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    // Exited between the caller's liveness check and the signal.
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}
