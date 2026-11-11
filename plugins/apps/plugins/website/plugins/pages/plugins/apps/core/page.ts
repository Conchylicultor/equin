import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The apps gallery, at `/about/apps`. */
export const appsPage = defineWebsitePage({
  path: "/about/apps",
  title: "Apps",
  description:
    "Every app equin ships, grouped by what it is for. Each one is a composition of plugins: install it as it is, or ask an agent to reshape it for you.",
});
