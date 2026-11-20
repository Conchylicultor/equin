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
  readVisitorPulse,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/server";
import { deploymentPulse } from "../../core";

/**
 * The pulse, run on this computer's copy of the site's analytics tables:
 * collect's own `readVisitorPulse` inside the replica's read-only snapshot,
 * as of the site's clock at the last page applied (`sourceNow` — never this
 * computer's clock, so "now" is when the copy was true). Pushed: each page the
 * replica commits notifies this deployment's tuple.
 */
export const deploymentPulseServed = serveValue(deploymentPulse, {
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
  loader: async ({ deploymentId }) => {
    const [deployment] = await db
      .select({ id: _deployDeployments.id })
      .from(_deployDeployments)
      .where(eq(_deployDeployments.id, deploymentIdKind.key(deploymentId)));
    if (deployment === undefined) {
      throw deploymentPulse.refuse(
        "missing",
        "This deployment no longer exists.",
      );
    }
    const read = await readSiteMirror(
      deploymentId,
      ANALYTICS_MIRROR_SET_ID,
      (tx, { sourceNow }) => readVisitorPulse(tx, sourceNow),
    );
    return read.ready
      ? { kind: "pulse" as const, ...read.value }
      : { kind: "not-copied" as const };
  },
  whileSubscribed: ({ deploymentId }, notify) =>
    onSiteMirrorApplied({ setId: ANALYTICS_MIRROR_SET_ID, deploymentId }, () =>
      notify(),
    ),
  // A busy site's beacons can apply pages several times a second; one pulse
  // a second is all a glance can show.
  throttleMs: 1000,
});
