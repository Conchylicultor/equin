import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The download page, at `/about/download`. */
export const downloadPage = defineWebsitePage({
  path: "/about/download",
  title: "Download",
  description:
    "How to run your own copy of equin: one install command, or a prompt for an agent to do it, and what to try once it is running.",
});
