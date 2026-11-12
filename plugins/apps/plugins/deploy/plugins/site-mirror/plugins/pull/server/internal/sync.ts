import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { resolveMirrorSet } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import {
  deploymentIdKind,
  type DeploymentId,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { siteMirrorSyncEndpoint } from "../../core";
import { ensureSiteReplica, requestPull } from "./jobs";
import { tableMirrorReplicas } from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import { siteMirrorReplicas } from "./tables";

/** A copy older than this is pulled again when a tab showing it opens. */
const STALE_ON_OPEN_MS = 5 * 60_000;

/**
 * On a tab open, is this replica's copy worth a pull? Yes when it was never
 * synced or not for a few minutes, and no pull is already asked for.
 */
async function staleOnOpen(
  deploymentKey: DeploymentId,
  setId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      requestedAt: siteMirrorReplicas.requestedAt,
      runError: siteMirrorReplicas.runError,
      lastAttemptAt: tableMirrorReplicas.lastAttemptAt,
      lastSyncedAt: tableMirrorReplicas.lastSyncedAt,
    })
    .from(siteMirrorReplicas)
    .innerJoin(
      tableMirrorReplicas,
      eq(tableMirrorReplicas.id, siteMirrorReplicas.replicaId),
    )
    .where(
      and(
        eq(siteMirrorReplicas.deploymentId, deploymentKey),
        eq(siteMirrorReplicas.setId, setId),
      ),
    );
  if (row === undefined) return true;
  // A run that threw or died ends nothing (`run_error` says so): it does not
  // count as a pull still coming.
  const asked =
    row.runError === null &&
    row.requestedAt !== null &&
    (row.lastAttemptAt === null || row.requestedAt > row.lastAttemptAt);
  if (asked) return false;
  return (
    row.lastSyncedAt === null ||
    Date.now() - row.lastSyncedAt.getTime() > STALE_ON_OPEN_MS
  );
}

/**
 * Ask for a pull now. With a set: that set's replica (created on the first
 * ask). Without: every replica the deployment already has. A write — it only
 * enqueues; the status value says how the pull went.
 */
export const handleSiteMirrorSync = implement(
  siteMirrorSyncEndpoint,
  async ({ body: { deploymentId, setId, reason } }) => {
    const key = deploymentIdKind.key(deploymentId);
    const [deployment] = await db
      .select({ id: _deployDeployments.id })
      .from(_deployDeployments)
      .where(eq(_deployDeployments.id, key));
    if (!deployment)
      throw new HttpError(404, "This deployment no longer exists.");
    if (setId !== undefined) {
      if ("kind" in resolveMirrorSet(setId)) {
        throw new HttpError(400, `This app declares no mirror set "${setId}".`);
      }
      if (reason === "open" && !(await staleOnOpen(key, setId))) return;
      await ensureSiteReplica(deploymentId, setId);
      await requestPull(deploymentId, setId);
      return;
    }
    const owned = await db
      .select({ setId: siteMirrorReplicas.setId })
      .from(siteMirrorReplicas)
      .where(eq(siteMirrorReplicas.deploymentId, key));
    for (const r of owned) {
      if (reason === "open" && !(await staleOnOpen(key, r.setId))) continue;
      await requestPull(deploymentId, r.setId);
    }
  },
);
