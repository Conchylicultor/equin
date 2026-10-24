import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const deployApp = defineApp({
  id: "deploy",
  name: "Deploy",
  basePath: "/deploy",
  icon: symbol("cloud"),
  audience: "developer",
});
