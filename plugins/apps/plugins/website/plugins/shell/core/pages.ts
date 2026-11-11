import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The homepage, at bare `/about`: the claim, then what it looks like. */
export const landingPage = defineWebsitePage({
  path: "/about",
  title: "A personal OS that evolves on request",
  description:
    "equin is an experimental open-source platform for rebuilding custom versions of every application, each tailored to the person using it: an exploration of the kind of software agents make possible.",
});
