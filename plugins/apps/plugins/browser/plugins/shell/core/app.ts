import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const browserApp = defineApp({
  id: "browser",
  name: "Browser",
  basePath: "/browser",
  icon: symbol("public"),
});
