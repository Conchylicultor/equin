import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const placesApp = defineApp({
  id: "places",
  name: "Places",
  basePath: "/places",
  icon: symbol("location-on"),
  category: "life",
  // Light only: the map's tiles are light whatever the mode, so the app
  // around them is too. Declared on the scheme, never per token group, so
  // every group — present and future — resolves its light values here.
  colorMode: "light",
});
