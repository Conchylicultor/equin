import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const websiteApp = defineApp({
  id: "website",
  name: "equin",
  basePath: "/website",
  icon: symbol("public"),
  audience: "developer",
});
