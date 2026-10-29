import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  countCommitsBehind,
  readCommitSubject,
  readRefSha,
} from "@plugins/release/plugins/bundles/server";
import { _deployRuns } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { runningCommit } from "../../core";
import {
  computeRunningCommit,
  MAIN_REF,
  type LatestShip,
} from "./running-commit";

/**
 * The verbs that put a bundle on the box. A converge changes the host around
 * the app, not the app, so a later converge does not move what is running.
 */
const SHIPPING_VERBS = ["ship", "update"] as const;

async function latestShip(deploymentId: string): Promise<LatestShip> {
  const [row] = await db
    .select({ id: _deployRuns.id, commitSha: _deployRuns.commitSha })
    .from(_deployRuns)
    .where(
      and(
        eq(_deployRuns.deploymentId, deploymentIdKind.key(deploymentId)),
        eq(_deployRuns.status, "succeeded"),
        inArray(_deployRuns.verb, [...SHIPPING_VERBS]),
      ),
    )
    .orderBy(desc(_deployRuns.startedAt))
    .limit(1);
  return row
    ? { kind: "shipped", runId: row.id, commitSha: row.commitSha }
    : { kind: "none" };
}

/**
 * Server half of `deploy.running-commit`.
 *
 * External because half its truth is git, which the change feed cannot see;
 * the other half is `deploy_runs`, declared in `reads` so a run landing
 * recomputes every subscribed deployment. `main` moving reaches it through the
 * git ref watcher's `refHead` (`recomputeOn`) — the same edge
 * `release.candidate` recomputes its staleness on. No timer anywhere.
 */
export const runningCommitServed = serveValue(runningCommit, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_deployRuns],
    reason:
      "the newest succeeded ship of the deployment — any run row landing may be it",
  },
  recomputeOn: [refHeadServed],
  loader: async ({ deploymentId }) =>
    computeRunningCommit(await latestShip(deploymentId), {
      subject: (sha) => readCommitSubject(sha, REPO_ROOT),
      mainSha: () => readRefSha(MAIN_REF, REPO_ROOT),
      behind: (sha, ref) => countCommitsBehind(sha, ref, REPO_ROOT),
    }),
});
