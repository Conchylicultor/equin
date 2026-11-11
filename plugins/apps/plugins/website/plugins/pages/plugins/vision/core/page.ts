import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The vision page, at `/about/vision`. */
export const visionPage = defineWebsitePage({
  path: "/about/vision",
  title: "A vision for applications",
  description:
    "What applications could become in the age of agents, as one zoom out: from a single idea to a new kind of app that could not exist before.",
});
