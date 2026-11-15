import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  flockTryShared,
  waitForFlock,
} from "@plugins/packages/plugins/flock/core";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import {
  checkoutBuildLock,
  checkoutRef,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import {
  MAIN_COMPOSITION_ID,
  namespaceFor,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { readBuildReceipt } from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";

/**
 * The desktop's `DatabaseDriverImpl.awaitDeploysSettled`: what can boot a new
 * owner of this process's database, on this machine, is a build of this
 * checkout or main's deploy. Three facts, read in this order:
 *
 * - **main's deploy is due** — on main's checkout only: its HEAD is not the
 *   commit main's last build took its lock for (the deploy receipt's
 *   `commit`). The gateway starts a convergence run on every advance of
 *   `refs/heads/main`, after a 5 s debounce and the CLI's bootstrap, so for
 *   those seconds a push's code is on disk with no lock held yet; HEAD not
 *   attempted is what says a deploy is on its way then. Nothing signals the run
 *   starting, so this never settles: the owner's NOTIFY, or the verifier's
 *   bound, ends the wait. Read FIRST: a build writes its receipt only once it
 *   holds the build lock, so a receipt naming HEAD means the lock waits below
 *   see that build.
 * - **the checkout's deploy lock** (`worktreeArtifacts.deployLock` of the
 *   checkout's own namespace — main's for every composition main serves):
 *   main's convergence run holds it exclusively from before it decides to its
 *   end, its compositions' builds and a second push's build included.
 * - **the checkout's build lock** (`checkoutBuildLock`): every `./equin
 *   build` holds it exclusively for its whole process, and does not exit
 *   before the backend it restarted reported its boot settled — after that
 *   backend's `onReady` recorded its schema stamp.
 *
 * Each lock is first tried shared without blocking (free: nothing to wait for,
 * no child spawned); held, it is waited for shared (`waitForFlock`: granted by
 * the kernel the moment its exclusive holder lets go — no polling) and dropped
 * at once. A lock file that does not exist was never held by anything, and is
 * not created: a checkout no build ran in (a release bundle's) has nothing to
 * wait for. A worktree's checkout has no deploy but its own builds: nothing
 * builds it on its own.
 */
export async function awaitDeploysSettled(
  signal: AbortSignal,
): Promise<readonly string[]> {
  const checkout = await checkoutRef(REPO_ROOT);
  const namespace = namespaceFor(MAIN_COMPOSITION_ID, checkout);
  if (checkout.kind === "main" && (await headUnattempted(namespace, signal))) {
    await untilAborted(signal);
  }
  return awaitLocksReleased(
    [
      {
        path: worktreeArtifacts.deployLock(namespace),
        what: "main's deploy",
      },
      { path: checkoutBuildLock(REPO_ROOT), what: "a build of this checkout" },
    ],
    signal,
  );
}

/** One `rev-parse`: bounded, since a wedged git must not hold a boot for ever. */
const GIT_TIMEOUT_MS = 30_000;

/** Whether this checkout's HEAD is not the commit `namespace`'s last build was for. */
async function headUnattempted(
  namespace: Namespace,
  signal: AbortSignal,
): Promise<boolean> {
  const [head, receipt] = await Promise.all([
    spawnExpectOk([GIT, "rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
    }),
    readBuildReceipt(namespace),
  ]);
  return receipt?.commit !== head.stdout.trim();
}

/** Resolves never; rejects with the signal's reason once it aborts. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** One lock a deploy holds, and what it is in words. */
export interface DeployLock {
  path: AppPath;
  what: string;
}

/**
 * Resolve once no process holds any of `locks` exclusively, one after the
 * other in order, with what each held one was. See `awaitDeploysSettled`.
 */
export async function awaitLocksReleased(
  locks: readonly DeployLock[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const waited: string[] = [];
  for (const { path, what } of locks) {
    if (!(await heldExclusively(path))) continue;
    waited.push(what);
    const held = await waitForFlock(path, { shared: true, signal });
    await held.release();
  }
  return waited;
}

/** Whether a process holds `path`'s flock exclusively now (no such file: never). */
async function heldExclusively(path: AppPath): Promise<boolean> {
  let fd;
  try {
    fd = await openOwnedFd(path, "r");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return false;
    throw err;
  }
  try {
    // Shared and non-blocking: refused only while someone holds it
    // exclusively. Granted, it is dropped with the fd just below.
    return !flockTryShared(fd.fd);
  } finally {
    fd.close();
  }
}
