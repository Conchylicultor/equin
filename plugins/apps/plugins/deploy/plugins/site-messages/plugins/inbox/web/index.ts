import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  SiteOverview,
  SiteTabs,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { MessagesCard } from "./components/messages-card";
import { MessagesSection } from "./components/messages-section";
import {
  useMessagesAvailable,
  useRecentMessagesBadge,
} from "./internal/use-messages-available";

export default {
  description:
    "Messages tab of a site's page, shown only when the deployment's composition ships the site-messages intake: the messages visitors sent through the site, read over SSH from the box on demand, as a DataView (received, from as a reply link, the message with its full text on open, verdict, notification state), with explicit states for every way the read can fail.",
  contributions: [
    SiteTabs.View({
      id: "messages",
      title: "Messages",
      icon: symbol("mail"),
      component: MessagesSection,
      useAvailable: useMessagesAvailable,
      useBadge: useRecentMessagesBadge,
    }),
    SiteOverview.Card({
      id: "messages",
      column: "side",
      component: MessagesCard,
    }),
  ],
} satisfies PluginDefinition;
