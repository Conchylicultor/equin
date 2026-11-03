import { sameCommit } from "./model";
import {
  resolved,
  unresolved,
} from "@plugins/network/plugins/live/plugins/live-state/core";
import type {
  BuildAttempt,
  ConvergenceKind,
  Deployment,
  DeploymentState,
} from "./model";

/**
 * Where the deployable carriers stand relative to the target. Pure: every git
 * question it needs was already answered into `ancestorOfTarget` by the server,
 * so this is decidable — and testable — without a checkout.
 *
 * The order of the arms is the whole content:
 *
 * 1. No target ⇒ `unknown`. Nothing can be behind a commit that does not exist.
 *    An empty carrier set is the same answer for the same reason: with nothing
 *    materialized there is nothing to compare, and reading that as "converged"
 *    (which `every` on an empty array would) would be a lie the shape of the one
 *    this design exists to remove.
 * 2. A carrier off the line ⇒ `diverged`. Checked BEFORE `converged` because a
 *    non-ancestor pin is a real statement about the app even when another
 *    carrier happens to sit exactly on the target.
 * 3. Every pin resolved and equal to the target ⇒ `converged`.
 * 4. Otherwise `behind` — which is where an UNRESOLVED pin lands, and that is
 *    deliberate. A server that cannot name one honest commit is not converged;
 *    treating it as converged is what would leave a mixed-tree process running.
 */
export function convergenceOf(d: Deployment): ConvergenceKind {
  if (!d.target.resolved) return "unknown";
  if (d.deployable.length === 0) return "unknown";
  const offLine = d.deployable.some(
    (c) => c.ancestorOfTarget.resolved && !c.ancestorOfTarget.value,
  );
  if (offLine) return "diverged";
  const target = d.target.value;
  const allAtTarget = d.deployable.every(
    (c) => c.commit.resolved && sameCommit(c.commit.value, target),
  );
  return allAtTarget ? "converged" : "behind";
}

/**
 * The ENTIRE auto-build policy, as a pure function of durable state.
 *
 * The point of extracting it is that the two properties the design rests on are
 * decidable here, with no db / config / git singleton in reach:
 *
 * **Termination.** A build that fails leaves the deployable carriers behind
 * permanently, so "not converged ⇒ build" alone would rebuild the same broken
 * commit for ever. The second clause stops that by asking whether this target
 * has ALREADY been attempted — stated as its own fact, rather than encoded in
 * the choice of which commit to compare against. That encoding is what produced
 * the original bug: the old decision compared against the commit the finished
 * build claimed, and the dist's pin recorded a commit the bundle was not built
 * from, so the two agreed while the app served the wrong bytes.
 *
 * **It ranges over the DEPLOYABLE carriers only.** `d.deployable` never contains
 * the tab; a stale tab produces a reload affordance, never a build. Otherwise a
 * tab nobody reloads would loop the reconciler for ever.
 *
 * Neither `unknown` nor `converged` builds: a release bundle has no checkout to
 * converge toward, and a converged deployment is the answer, not a problem.
 * Both `behind` and `diverged` do — a carrier off the line is running code that
 * is not on the way to the target, which one build from the tip fixes.
 */
export function wantsBuild(
  d: Deployment,
  lastAttempt: BuildAttempt | null,
): boolean {
  if (!d.target.resolved) return false;
  const kind = convergenceOf(d);
  if (kind === "converged" || kind === "unknown") return false;
  // Already tried this target — ok or failed, the outcome deliberately does not
  // enter it (see BuildAttempt.ok). A `null` commit on the attempt means the row
  // cannot say what it was for, which is not evidence that this target was
  // attempted, so it does not stop the build; the build it mints records a
  // commit, so the chain still terminates after exactly one extra run.
  //
  // ABSOLUTE — no carrier state exempts a target from it, and in particular an
  // `unresolved` pin does not. It is tempting to exempt one: a mixed-boot server
  // is not converged, and a rebuild + restart is what would clear it. But if a
  // pin is unresolvable for a PERSISTENT reason rather than a transient one (the
  // module-eval sample fails while `target` still resolves), that exemption is an
  // unbounded loop — every build restarts the backend, the new process fails the
  // sample again, and it rebuilds for ever. Termination is the only thing
  // standing between this reconciler and that loop, so it does not get holes.
  //
  // What that costs: a mixed-boot server is NOT self-healing through auto-build.
  // It stays mixed until the target next moves. Acceptable, because the state is
  // now loudly visible rather than silent (the chain renders it as not
  // converged — the entire point of this redesign), and a manual Build bypasses
  // `wantsBuild` by design, so a human has a one-click escape hatch.
  if (
    lastAttempt !== null &&
    lastAttempt.commit !== null &&
    sameCommit(lastAttempt.commit, d.target.value)
  )
    return false;
  return true;
}

/**
 * The raw facts back out of the wire payload — exact, not lossy: every arm
 * carries `deployable`, the three answerable arms carry `target`, and `unknown`
 * carries the very reason the target was unresolvable.
 *
 * It exists so the reconciler and the resource share ONE read. Both need the
 * same git work; without this the reconciler would re-derive the facts itself
 * and pay the ancestry probes a second time, on every edge.
 */
export function deploymentOf(state: DeploymentState): Deployment {
  return {
    target:
      state.kind === "unknown"
        ? unresolved(state.reason)
        : resolved(state.target),
    deployable: state.deployable,
  };
}
