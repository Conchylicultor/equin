import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const demoApp = defineApp({
  id: "demo",
  name: "Demo",
  basePath: "/demo",
  icon: symbol("smart-display"),
});
