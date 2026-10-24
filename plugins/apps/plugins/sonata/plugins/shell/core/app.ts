import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const sonataApp = defineApp({
  id: "sonata",
  name: "Sonata",
  basePath: "/sonata",
  icon: symbol("piano"),
});
