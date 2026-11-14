import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const isleApp = defineApp({
  id: "isle",
  name: "Isle",
  basePath: "/isle",
  icon: symbol("sailing"),
  category: "play",
  colorMode: "light",
});
