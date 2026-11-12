import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { IdKinds } from "@plugins/ids/server";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { sendSiteMessageEndpoint, siteMessageIdKind } from "../core";
import {
  siteMessagesConfirmJob,
  siteMessagesNotifyJob,
} from "./internal/notify-job";
import { siteMessagesSpamRetention } from "./internal/retention";
import { siteMessagesMirrorContributions } from "./internal/mirror";
import { handleSendSiteMessage } from "./internal/routes";
import { siteMessages } from "./internal/tables";

// A demo's seed stores received messages through this.
export { insertReceivedSiteMessage } from "./internal/received";
// The deploy app's inbox reads the mirrored copy of this table with it.
export { siteMessages } from "./internal/tables";

export default {
  description:
    "Owns site_messages: the public POST /api/site-messages endpoint (body capped at 8 KB; honeypot, a send under three seconds or a bot user agent stored as spam and still answered sent; 3 per 10 minutes and 10 per day per salted IP hash, the IP never stored), the site-messages.notify job emailing each accepted message through Resend from the approved RESEND_API_KEY deploy secret (not-configured without one, at most 30 emails a day, the rest held and counted in the next), the site-messages.confirm job emailing the visitor a copy so they know it arrived (at most 30 a day and 3 a day per address), the 30-day spam sweep, and the site_messages mirror set the deploy app copies (ip_hash omitted, the salt never mirrored).",
  httpRoutes: {
    [sendSiteMessageEndpoint.route]: rawEndpointHandler(
      sendSiteMessageEndpoint,
      handleSendSiteMessage,
    ),
  },
  contributions: [
    IdKinds.Kind({ kind: siteMessageIdKind }),
    // Public traffic writes it; nothing renders it live here (the deploy
    // app's inbox reads its mirrored copy), so a change-feed trigger would be
    // pure notify churn driven by internet traffic.
    ExcludeFromChangeFeed({
      table: siteMessages,
      reason:
        "Written by the public contact form; no live-state resource reads it — the deploy app's inbox reads its mirrored copy (site-mirror), whose own change signal is the mirror's.",
    }),
    // The site_messages mirror set (the deploy app's site-mirror copies it,
    // without ip_hash); the salt never leaves.
    ...siteMessagesMirrorContributions,
  ],
  register: [
    siteMessagesNotifyJob,
    siteMessagesConfirmJob,
    siteMessagesSpamRetention,
  ],
} satisfies ServerPluginDefinition;
