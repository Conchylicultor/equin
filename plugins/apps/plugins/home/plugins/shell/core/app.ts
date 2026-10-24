import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const homeApp = defineApp({
  id: "home",
  name: "Home",
  basePath: "/home",
  icon: symbol("home"),
});
