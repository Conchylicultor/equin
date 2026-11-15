import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  flockRelease,
  flockTry,
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
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";

/**
 * The desktop's `DatabaseDriverImpl.awaitDeploysSettled`: what can bring this
 * process's database a stamp for new code, on this machine, is a serving
 * backend booting toward it — started by a build of this checkout, by main's
 * deploy, or by the gateway's respawn. Four facts, read in this order:
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
 *   build` holds it exclusively for its whole process — across its backend's
 *   spawn, until that backend's boot settled or a deadline arm gave up on it.
 * - **the namespace's schema-owner boot marker**
 *   (`worktreeArtifacts.schemaOwnerBoot`, `./owner-boot.ts`): the direct
 *   signal. Every serving backend holds it shared from its entry point until
 *   its `onReady` recorded the stamp (or failed to), so it holds however the
 *   build exited — a deadline arm returns `ok` while the backend is still
 *   booting (task-1794739540-eqmg40). Read LAST: a build or deploy holds its
 *   lock across the spawn of the backend that takes it.
 *
 * Each exclusive lock is first tried shared without blocking (free: nothing to
 * wait for, no child spawned); held, it is waited for shared (`waitForFlock`:
 * granted by the kernel the moment its exclusive holder lets go — no polling)
 * and dropped at once. The boot marker, held shared, is tried and waited for
 * exclusively instead: granted once no booting backend holds it. A lock file that does not exist was never held by anything, and is
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
      {
        path: worktreeArtifacts.schemaOwnerBoot(runtimeNamespace()),
        what: "the serving backend's boot",
        heldBy: "shared",
      },
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
  /**
   * How its holders take it: `exclusive` (the default — one build, one
   * deploy) or `shared` (the boot marker: any number of booting backends).
   */
  heldBy?: "exclusive" | "shared";
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
  for (const { path, what, heldBy = "exclusive" } of locks) {
    if (!(await held(path, heldBy))) continue;
    waited.push(what);
    // Wait in the mode that conflicts with the holders': shared behind an
    // exclusive holder, exclusive behind shared ones.
    const granted = await waitForFlock(path, {
      shared: heldBy === "exclusive",
      signal,
    });
    await granted.release();
  }
  return waited;
}

/**
 * Whether a process holds `path`'s flock in `mode` now (no such file: never):
 * an exclusive holder refuses a shared try, a shared one an exclusive try.
 */
async function held(
  path: AppPath,
  mode: "exclusive" | "shared",
): Promise<boolean> {
  let fd;
  try {
    fd = await openOwnedFd(path, "r");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return false;
    throw err;
  }
  try {
    // Non-blocking, in the mode the holders' conflicts with. Granted, it is
    // dropped at once (the exclusive grant explicitly, so a booting backend's
    // shared try right after never sees it).
    if (mode === "exclusive") return !flockTryShared(fd.fd);
    if (!flockTry(fd.fd)) return true;
    flockRelease(fd.fd);
    return false;
  } finally {
    fd.close();
  }
}
