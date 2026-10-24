import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";

import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { homeApp } from "../core";
import { HomeLayout } from "./components/home-layout";
import { homeTheme } from "./internal/theme";
import { Home } from "./slots";
import { homeRootPane } from "./panes";

export { Home } from "./slots";
export { homeRootPane } from "./panes";

export default {
  description:
    "App shell for Home. Registers the /home app entry and its launcher pane (the index of a full-pane surface), defines the Home.Section slot, and contributes Home's own theme (a black page and the ocean tile palette), which the home app selects.",
  contributions: [
    Apps.App({
      app: homeApp,
      component: HomeLayout,
    }),
    Pane.Register({ pane: homeRootPane }),
    // The launcher's theme, selected for the home app in
    // `config/ui/theme-engine/@app/home/theme.jsonc`.
    ThemeEngine.Theme(homeTheme),
  ],
  slots: { ...Home, homeRoot: homeRootPane },
} satisfies PluginDefinition;
