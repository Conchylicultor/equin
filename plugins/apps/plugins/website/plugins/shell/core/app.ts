import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { WEBSITE_BASE_PATH } from "@plugins/apps/plugins/website/plugins/crawlable/core";

export const websiteApp = defineApp({
  id: "website",
  name: "equin",
  // The pages' address space (`crawlable`): a page path and the app it
  // renders in cannot disagree.
  basePath: WEBSITE_BASE_PATH,
  icon: symbol("public"),
  audience: "developer",
});
