import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The privacy page, at `/about/privacy`. */
export const privacyPage = defineWebsitePage({
  path: "/about/privacy",
  title: "Privacy",
  description:
    "What a visit to equin.ai records, how a return visit is recognised, how long it is kept, and the choice each browser makes.",
});
