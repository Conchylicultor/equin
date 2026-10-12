import { serveValue } from "@plugins/network/plugins/live/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { deployment } from "../../core";
import { deploymentEtag, readDeploymentState } from "./read-deployment";

/**
 * The live half of the deployment description. External (its truth is git plus
 * two dotfiles in the served dist, not Postgres), and it recomputes on exactly
 * the two things that can change the answer:
 *
 * - **the target moved** — any tracked ref advance, via `refHeadServed`. No
 *   ref-name filter: main's checkout is on `main` and a worktree checkout is on
 *   its own branch, and `HEAD` is the target in both, so every ref this backend
 *   tracks is one that can move its own target.
 * - **a build republished the dist** — an explicit `notify()` from `run-build`
 *   when a build reaches terminal, and from this plugin's own `onAllReady` once
 *   the server pin is sealed.
 *
 * Nothing polls it. Between those two edges the answer cannot change.
 *
 * `revalidate` is the memo's own signature probe, so a resubscribe herd after a
 * restart — and the main-advance fan-out that wakes this loader in every
 * worktree backend — is answered "still current" from one `rev-parse` instead of
 * a recompute. Bound to the loader through `createSignedMemo`, so the ETag and
 * the value cannot come to disagree.
 */
export const deploymentServed = serveValue(deployment, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: async () => readDeploymentState(),
  revalidate: async () => deploymentEtag(),
});
