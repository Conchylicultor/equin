import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { WEBSITE_BASE_PATH } from "@plugins/apps/plugins/website/plugins/crawlable/core";

export const websiteApp = defineApp({
  id: "website",
  name: "equin",
  // The pages' address space (`crawlable`): a page path and the app it
  // renders in cannot disagree.
  basePath: WEBSITE_BASE_PATH,
  // Where the site lived before `/about`: links published then (the README,
  // shared URLs, search results) are answered with a 301 to the same page.
  formerBasePaths: ["/website"],
  icon: symbol("public"),
  audience: "developer",
});
