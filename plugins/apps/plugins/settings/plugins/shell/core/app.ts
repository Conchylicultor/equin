import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const settingsApp = defineApp({
  id: "settings",
  name: "Settings",
  basePath: "/settings",
  icon: symbol("settings"),
  iconColor: "slate",
});
