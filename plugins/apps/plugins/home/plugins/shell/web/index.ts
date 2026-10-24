import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { homeApp } from "../core";
import { HomeLayout } from "./components/home-layout";
import { homeTheme } from "./internal/theme";
import { Home } from "./slots";

export { Home } from "./slots";

export default {
  description:
    "App shell for Home. Registers the /home app entry, defines the Home.Section slot, and contributes Home's own theme (a black page and the ocean tile palette), which the home app selects.",
  contributions: [
    Apps.App({
      app: homeApp,
      component: HomeLayout,
    }),
    // The launcher's theme, selected for the home app in
    // `config/ui/theme-engine/@app/home/theme.jsonc`.
    ThemeEngine.Theme(homeTheme),
  ],
  slots: Home,
} satisfies PluginDefinition;
