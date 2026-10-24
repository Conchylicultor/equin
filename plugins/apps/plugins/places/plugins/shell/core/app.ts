import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const placesApp = defineApp({
  id: "places",
  name: "Places",
  basePath: "/places",
  icon: symbol("location-on"),
});
