import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

/**
 * How far the user has read a site's messages: one row per deployment, the
 * `deploy_deployments_ext_messages_seen` side-table (built from this shape in
 * `server/internal/tables.ts`). `seenAt` is the site's clock (the copy's
 * `sourceNow`) when the user last opened the Messages tab — every message the
 * copy held then was on screen — so the messages "new" since are exactly those
 * received after it, compared on the box's own clock. No row: never opened, so
 * every message is new.
 */
export const messagesSeenShape = defineExtensionShape({
  key: "deploymentId",
  fields: { seenAt: dateField() },
});

/** One deployment's seen mark, read by id (`useLive(siteMessagesSeen, { id })`). */
export const siteMessagesSeen = liveCollection("deploy-site-messages.seen", {
  from: messagesSeenShape,
  id: "deploymentId",
});

/**
 * Mark a site's messages seen up to its copy's clock (`sourceNow`): the mark
 * only moves forward. 409 while the copy is not readable (the Messages tab
 * marks only once its list is on screen, so that is a race with a reset copy),
 * 404 for a deployment that does not exist.
 */
export const markSiteMessagesSeen = defineEndpoint({
  route: "POST /api/deploy/deployments/:id/messages-seen",
});
