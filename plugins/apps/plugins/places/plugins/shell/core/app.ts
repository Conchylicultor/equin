import { defineApp } from "@plugins/primitives/plugins/pane/core";

export const placesApp = defineApp({
  id: "places",
  name: "Places",
  basePath: "/places",
  iconKey: "location-on",
});
