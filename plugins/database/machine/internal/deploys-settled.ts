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
  isMainSlotCheckout,
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
import type { DeploysSettled } from "../../server/internal/driver";

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
 * **A main slot main moved past is `superseded`, at once.** A slot is a
 * checkout of the commit it was built from, and its HEAD never moves: when it
 * is not the commit main's last build took its lock for, the slot is an old
 * one — a draining backend still runs there and spawns children, and a newer
 * backend has (or is about to have) set the schema up for newer code. No
 * deploy will ever boot an owner of the slot's code, so waiting on main's
 * deploy, build and boot locks is waiting on someone else's deploy: on
 * 2026-11-18 a spare refill the draining backend spawned 4 s before the switch
 * read HEAD-not-attempted as a deploy on its way and held its old slot the
 * whole 10 min bound, through two more pushes (report-1794960565-yv4ch2). Only
 * main's own checkout — whose HEAD a push advances before its build starts —
 * reads that mismatch as a deploy on its way.
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
): Promise<DeploysSettled> {
  const checkout = await checkoutRef(REPO_ROOT);
  const namespace = namespaceFor(MAIN_COMPOSITION_ID, checkout);
  if (checkout.kind === "main") {
    const { head, built } = await headAndLastBuilt(namespace, signal);
    if (built !== head) {
      if (await isMainSlotCheckout(REPO_ROOT))
        return { kind: "superseded", detail: supersededSlot(head, built) };
      await untilAborted(signal);
    }
  }
  const waitedOn = await awaitLocksReleased(
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
  return { kind: "settled", waitedOn };
}

/** Why a superseded main slot's code will never be set up, in words. */
function supersededSlot(head: string, built: string | null): string {
  const was =
    built === null
      ? "main's last build recorded no commit"
      : `main's last build was for ${built.slice(0, 10)}`;
  return `this process runs from a main slot of ${head.slice(0, 10)} and ${was}: main has moved past this slot, so no deploy will set the database up for its code — only a process started from the slot main serves now can run`;
}

/** One `rev-parse`: bounded, since a wedged git must not hold a boot for ever. */
const GIT_TIMEOUT_MS = 30_000;

/** This checkout's HEAD, and the commit `namespace`'s last build was for (null: none recorded). */
async function headAndLastBuilt(
  namespace: Namespace,
  signal: AbortSignal,
): Promise<{ head: string; built: string | null }> {
  const [head, receipt] = await Promise.all([
    spawnExpectOk([GIT, "rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
    }),
    readBuildReceipt(namespace),
  ]);
  return { head: head.stdout.trim(), built: receipt?.commit ?? null };
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
