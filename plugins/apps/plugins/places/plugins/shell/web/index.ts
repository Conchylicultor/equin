import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { placesApp } from "../core";
import { PlacesLayout } from "./components/places-layout";

export default {
  description:
    "The Places app's rail entry and frame: the standard sidebar-less app shell around the full-pane renderer, where the map's index pane is shown.",
  contributions: [
    Apps.App({
      app: placesApp,
      icon: appIcon(symbol("location-on")),
      component: PlacesLayout,
    }),
  ],
} satisfies PluginDefinition;
