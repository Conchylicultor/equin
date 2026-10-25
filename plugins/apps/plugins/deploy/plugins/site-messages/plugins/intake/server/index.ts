import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/database/plugins/change-feed/server";
import { IdKinds } from "@plugins/ids/server";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import {
  sendSiteMessageEndpoint,
  siteMessageIdKind,
  siteMessagesListEndpoint,
} from "../core";
import { siteMessagesNotifyJob } from "./internal/notify-job";
import { siteMessagesSpamRetention } from "./internal/retention";
import {
  handleListSiteMessages,
  handleSendSiteMessage,
} from "./internal/routes";
import { siteMessages } from "./internal/tables";

export default {
  description:
    "Owns site_messages: the public POST /api/site-messages endpoint (body capped at 8 KB; honeypot, a send under three seconds or a bot user agent stored as spam and still answered sent; 3 per 10 minutes and 10 per day per salted IP hash, the IP never stored), the site-messages.notify job emailing each accepted message through Resend from the approved RESEND_API_KEY deploy secret (not-configured without one, at most 30 emails a day, the rest held and counted in the next), the 30-day spam sweep, and the host-only list the deploy app reads over SSH.",
  httpRoutes: {
    [sendSiteMessageEndpoint.route]: rawEndpointHandler(
      sendSiteMessageEndpoint,
      handleSendSiteMessage,
    ),
    [siteMessagesListEndpoint.route]: handleListSiteMessages,
  },
  contributions: [
    IdKinds.Kind({ kind: siteMessageIdKind }),
    // Public traffic writes it; nothing renders it live (the inbox reads a
    // page over SSH on demand), so a change-feed trigger would be pure notify
    // churn driven by internet traffic.
    ExcludeFromChangeFeed({
      table: siteMessages,
      reason:
        "Written by the public contact form; no live-state resource reads it — the deploy app's inbox reads a page over SSH on demand.",
    }),
  ],
  register: [siteMessagesNotifyJob, siteMessagesSpamRetention],
} satisfies ServerPluginDefinition;
