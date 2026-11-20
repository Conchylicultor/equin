import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { markSiteMessagesSeen } from "../shared";
import { siteMessagesInboxServed } from "./internal/served";
import {
  handleMarkSiteMessagesSeen,
  siteMessagesSeenServed,
} from "./internal/seen";

export default {
  description:
    "Serves deploy-site-messages.inbox: a deployed site's contact-form messages as a live window over this computer's copy of the site's site_messages (site-mirror's replica of the intake's mirror set) — newest first, filtered, searched, grouped and counted in SQL on the copy, re-read whenever a sync applies a page. Owns the deploy_deployments_ext_messages_seen side-table — how far the user has read each site's messages, as the site's clock when they last opened the Messages tab — served by id (deploy-site-messages.seen) and moved forward by POST /api/deploy/deployments/:id/messages-seen.",
  contributions: [
    ...siteMessagesInboxServed.declare,
    ...siteMessagesSeenServed.declare,
  ],
  httpRoutes: {
    [markSiteMessagesSeen.route]: handleMarkSiteMessagesSeen,
  },
} satisfies ServerPluginDefinition;
