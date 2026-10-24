import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const prototypesApp = defineApp({
  id: "prototypes",
  name: "Prototypes",
  basePath: "/prototypes",
  icon: symbol("dashboard-customize"),
});
