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
 * Wait for a stopped process to be gone, bounded to the gateway's own 15s
 * shutdown budget plus launchd's margin (the job's ExitTimeOut is 20s). Throws
 * if it outlives that.
 *
 * A stop must be observed, not assumed: a fixed sleep let an old gateway keep
 * tearing down its backends while the new one booted and ran its orphan
 * reconcile — overlapping generations, the routine trigger for orphaned
 * backends. A process exit has no event a non-parent can wait on, so this is a
 * bounded wait on the one fact that matters, not a change watch.
 */
export async function awaitProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (processExists(pid) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (processExists(pid)) {
    throw new Error(
      `Process ${pid} is still running 20s after being stopped; refusing to carry on as if it were gone.`,
    );
  }
}

/** SIGTERM a process and {@link awaitProcessGone | wait for it to be gone}. */
export async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // Exited between the caller's liveness check and the signal.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  await awaitProcessGone(pid);
}
