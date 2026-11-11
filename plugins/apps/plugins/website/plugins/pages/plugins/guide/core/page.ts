import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The getting-started guide, at `/about/guide`. */
export const guidePage = defineWebsitePage({
  path: "/about/guide",
  title: "Getting started",
  description:
    "Your first tasks, agents and changes once equin is running, step by step.",
});
