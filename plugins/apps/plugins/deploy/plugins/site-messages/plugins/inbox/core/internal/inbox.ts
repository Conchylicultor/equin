import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { HOST_QUERY_FAILURE_ARMS } from "@plugins/apps/plugins/deploy/plugins/host-query/core";
import { SiteMessagesPageSchema } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";

/** A deployment id's length cap in a question (ids are `dpl-<stamp>-<suffix>`, far shorter). */
const DEPLOYMENT_ID_MAX_LENGTH = 128;

/**
 * What asking a deployment for its messages answered: one page (the intake's
 * own answer, verbatim) or one of host-query's failure arms. Never an empty
 * page standing in for a failure.
 */
export const DeploymentSiteMessagesResultSchema = z.discriminatedUnion("kind", [
  SiteMessagesPageSchema,
  ...HOST_QUERY_FAILURE_ARMS,
]);
export type DeploymentSiteMessagesResult = z.infer<
  typeof DeploymentSiteMessagesResultSchema
>;

/**
 * A deployment's stored messages, read over SSH from its box — the newest
 * page of every verdict. A snapshot: the messages are the deployed site's own
 * data, with no change signal here, so they are measured when a reader asks
 * (each mount, and Refresh), never on a timer. A deployment that does not
 * exist is refused `missing`. Bounded by the intake's page cap
 * (`SITE_MESSAGES_PAGE_MAX`).
 */
export const deploymentSiteMessages = liveValue("deploy-site-messages.list", {
  schema: DeploymentSiteMessagesResultSchema,
  query: z
    .object({ deploymentId: z.string().min(1).max(DEPLOYMENT_ID_MAX_LENGTH) })
    .strict(),
  load: "snapshot",
  refusals: ["missing"],
});
