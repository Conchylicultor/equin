import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The getting-started guide, at `/website/guide`. */
export const guidePage = defineWebsitePage({
  path: "/website/guide",
  title: "Getting started",
  description:
    "Your first tasks, agents and changes once equin is running, step by step.",
});
