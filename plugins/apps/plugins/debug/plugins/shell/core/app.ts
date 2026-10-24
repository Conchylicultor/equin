import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const debugApp = defineApp({
  id: "debug",
  name: "Debug",
  basePath: "/debug",
  icon: symbol("bug-report"),
});
