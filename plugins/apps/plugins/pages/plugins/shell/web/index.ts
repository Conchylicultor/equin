import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { pagesApp } from "../core";
import { PagesLayout } from "./components/pages-layout";
import {
  PagesWorkspaceMark,
  PagesWorkspaceName,
} from "./components/pages-workspace";
import { Pages } from "./slots";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { pagesInkTheme } from "./internal/theme";

export { Pages } from "./slots";
export { PagesSidebarRow } from "./components/pages-sidebar-row";

export default {
  description:
    "App shell for Pages. Registers the /pages app entry — its brand the workspace (the user's initial tile as the launcher mark, and \"<first name>'s pages\" from the OS account) — defines the Pages.Sidebar slot, and contributes the app's own theme (Ink), which Pages selects.",
  contributions: [
    Apps.App({
      app: pagesApp,
      // The sidebar's brand is the workspace: the user's initial tile (still
      // the app launcher) and "<first name>'s pages".
      mark: PagesWorkspaceMark,
      brandName: PagesWorkspaceName,
      component: PagesLayout,
    }),
    // The Pages theme, selected for the app in
    // `config/ui/theme-engine/@app/pages/theme.jsonc`.
    ThemeEngine.Theme(pagesInkTheme),
  ],
  slots: Pages,
} satisfies PluginDefinition;
