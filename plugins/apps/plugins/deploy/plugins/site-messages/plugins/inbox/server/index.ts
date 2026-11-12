import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { siteMessagesInboxServed } from "./internal/served";

export default {
  description:
    "Serves deploy-site-messages.inbox: a deployed site's contact-form messages as a live window over this computer's copy of the site's site_messages (site-mirror's replica of the intake's mirror set) — newest first, filtered, searched, grouped and counted in SQL on the copy, re-read whenever a sync applies a page.",
  contributions: [...siteMessagesInboxServed.declare],
} satisfies ServerPluginDefinition;
