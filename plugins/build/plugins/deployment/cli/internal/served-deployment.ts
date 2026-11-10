import {
  getServerCommit,
  getServerGraphHash,
} from "@plugins/build/plugins/server-build-id/server";
import type { Deployment } from "../../core";
import {
  readTarget,
  webCarrier,
  withAncestry,
} from "../../machine/internal/git-chain";

/**
 * The deployment as a process OUTSIDE the backend can read it: this checkout's
 * HEAD and the `web` carrier — the dist the gateway serves, pinned by the
 * trailers the build stamps into it.
 *
 * The `server` carrier is absent, and that is a fact rather than a shortcut:
 * its pin is the running backend's own module-eval sample of HEAD, held in that
 * process's memory, and there may be no such process at all — the reader this
 * exists for is main's convergence run (`build/converge`), whose whole point is
 * to work while main's backend is down. The served dist is a faithful stand-in
 * for what was last DEPLOYED: a deploy whose backend does not come up rolls its
 * dist back (`deploy-namespace.ts`), so the dist names the last commit whose
 * backend was accepted. What it cannot see — a mixed boot, a backend that
 * later crashed on the same code — is not something a rebuild of the same
 * commit fixes either (`wantsBuild`'s termination refuses it regardless).
 *
 * The caller's process must already run as the namespace whose dist this reads
 * (`actAsCheckoutNamespace`): `getServerCommit` resolves `webDistDir()` from it.
 */
export async function readServedDeployment(): Promise<Deployment> {
  const target = await readTarget();
  const [distCommit, distGraph] = await Promise.all([
    getServerCommit(),
    getServerGraphHash(),
  ]);
  return {
    target,
    deployable: [await withAncestry(webCarrier(distCommit, distGraph), target)],
  };
}
