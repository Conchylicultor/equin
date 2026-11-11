import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The download page, at `/website/download`. */
export const downloadPage = defineWebsitePage({
  path: "/website/download",
  title: "Download",
  description:
    "How to run your own copy of equin: one install command, or a prompt for an agent to do it, and what to try once it is running.",
});
