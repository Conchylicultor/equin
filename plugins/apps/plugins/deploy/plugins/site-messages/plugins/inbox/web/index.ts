import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  SiteOverview,
  SiteTabs,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { MessagesCard } from "./components/messages-card";
import { MessagesSection } from "./components/messages-section";
import { investigateSiteMessages } from "./internal/investigate";
import {
  useMessagesAvailable,
  useRecentMessagesBadge,
} from "./internal/use-messages-available";

import { SiteVisitors } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard/web";
import {
  NewMessagesNote,
  NewMessagesNoteExhibit,
} from "./components/new-messages-note";

export default {
  description:
    "Messages tab of a site's page, shown only when the deployment's composition ships the site-messages intake: every message visitors sent through the site, from this computer's copy of the site's messages (site-mirror), as a live DataView paged, searched and filtered in SQL (received, from as a reply link, the message with its full text on open, verdict, notification state), under the copy's freshness line; the Overview's newest-messages card, the tab's 7-day badge and the health report's deployed-site row (\"N new messages\" since the tab was last opened, linking to it) read the same copy.",
  contributions: [
    investigateSiteMessages,
    // The health report's deployed-site row: "N new messages" after the
    // Visitors block's count, linking to the Messages tab.
    SiteVisitors.Note({
      id: "new-messages",
      component: NewMessagesNote,
      exhibit: NewMessagesNoteExhibit,
    }),
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
