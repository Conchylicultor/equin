import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { tableMirrorReplicas } from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import {
  onSiteMirrorApplied,
  readSiteMirror,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/server";
import { ANALYTICS_MIRROR_SET_ID } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  analyticsMirrorTables,
  runAnalyticsQuery,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/server";
import { deploymentAnalytics } from "../../core";

/**
 * The report, run on this computer's copy of the site's analytics tables:
 * collect's own `runAnalyticsQuery` — no second implementation — inside the
 * replica's read-only snapshot (`search_path` = the copy, so its unqualified
 * tables are the site's, and a table the set does not mirror fails), as of the
 * site's clock at the last page applied. Pushed: each page the replica
 * commits notifies this deployment's tuples (`onSiteMirrorApplied`).
 */
export const deploymentAnalyticsServed = serveValue(deploymentAnalytics, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_deployDeployments],
    reason:
      "Whether the deployment still exists (refused `missing` once it is deleted), read before the copy.",
    notified: {
      relations: [tableMirrorReplicas, ...analyticsMirrorTables],
      reason:
        "The replica's state and its copy of the site's analytics tables move only when a pull applies a page, whose commit NOTIFYs table_mirror — heard per deployment by onSiteMirrorApplied.",
    },
  },
  loader: async ({ deploymentId, query }) => {
    const [deployment] = await db
      .select({ id: _deployDeployments.id })
      .from(_deployDeployments)
      .where(eq(_deployDeployments.id, deploymentIdKind.key(deploymentId)));
    if (deployment === undefined) {
      throw deploymentAnalytics.refuse(
        "missing",
        "This deployment no longer exists.",
      );
    }
    const read = await readSiteMirror(
      deploymentId,
      ANALYTICS_MIRROR_SET_ID,
      (tx, { sourceNow }) => runAnalyticsQuery(tx, query, sourceNow),
    );
    return read.ready ? read.value : { kind: "not-copied" as const };
  },
  whileSubscribed: ({ deploymentId }, notify) =>
    onSiteMirrorApplied(
      { setId: ANALYTICS_MIRROR_SET_ID, deploymentId },
      () => notify(),
    ),
  // A first copy or a reconcile commits a page after another; one report per
  // second is all a reader can see of it.
  throttleMs: 1000,
});
