import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const studioApp = defineApp({
  id: "studio",
  name: "Studio",
  basePath: "/studio",
  icon: symbol("extension"),
  audience: "developer",
});
