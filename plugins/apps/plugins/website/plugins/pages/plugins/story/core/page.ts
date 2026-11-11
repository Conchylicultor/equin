import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The story page, at `/about/story`. */
export const storyPage = defineWebsitePage({
  path: "/about/story",
  title: "How equin came to be",
  description:
    "Eight years as an AI research engineer at Google Brain and DeepMind, one week with Claude Opus 4.6, then a resignation and a project built alone: how equin started.",
});
