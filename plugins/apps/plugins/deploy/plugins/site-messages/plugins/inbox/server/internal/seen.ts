import { eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { serveCollection } from "@plugins/network/plugins/live/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { readSiteMirror } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/server";
import { SITE_MESSAGES_MIRROR_SET_ID } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import { markSiteMessagesSeen, siteMessagesSeen } from "../../shared";
import { _deployDeploymentsMessagesSeenExt, messagesSeen } from "./tables";

/** Each deployment's seen mark, read by id, from the side-table (change feed). */
export const siteMessagesSeenServed = serveCollection(siteMessagesSeen, {
  from: messagesSeen,
});

/**
 * Mark a site's messages seen as of its copy's clock (`sourceNow`, the box's
 * clock at the last page synced): every message the copy holds was received at
 * or before it, so they were all on screen. The mark never moves back (a tab
 * opened on an older snapshot leaves a newer mark alone).
 */
export const handleMarkSiteMessagesSeen = implement(
  markSiteMessagesSeen,
  async ({ params }) => {
    const [deployment] = await db
      .select({ id: _deployDeployments.id })
      .from(_deployDeployments)
      .where(eq(_deployDeployments.id, deploymentIdKind.key(params.id)));
    if (deployment === undefined)
      throw new HttpError(404, "This deployment no longer exists.");
    const read = await readSiteMirror(
      params.id,
      SITE_MESSAGES_MIRROR_SET_ID,
      async (_tx, { sourceNow }) => sourceNow,
    );
    if (!read.ready)
      throw new HttpError(
        409,
        `This site's copy of its messages is not readable yet (${read.phase}).`,
      );
    const t = _deployDeploymentsMessagesSeenExt;
    await db
      .insert(t)
      .values({ deploymentId: deployment.id, seenAt: read.value })
      .onConflictDoUpdate({
        target: t.deploymentId,
        set: { seenAt: sql`GREATEST(${t.seenAt}, excluded.seen_at)` },
      });
  },
);
