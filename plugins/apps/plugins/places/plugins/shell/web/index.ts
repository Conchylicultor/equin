import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { placesApp } from "../core";
import { PlacesLayout } from "./components/places-layout";
import { placesTheme } from "./internal/theme";

export default {
  description:
    "The Places app's rail entry and frame: the standard sidebar-less app shell around the full-pane renderer, where the map's index pane is shown, and the app's own light-only theme, which the places app selects.",
  contributions: [
    Apps.App({
      app: placesApp,
      icon: appIcon(symbol("location-on")),
      component: PlacesLayout,
    }),
    // Selected for the places app in `config/ui/theme-engine/@app/places/theme.jsonc`.
    ThemeEngine.Theme(placesTheme),
  ],
} satisfies PluginDefinition;
