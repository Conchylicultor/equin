import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { MenuBar } from "@plugins/menu-bar/web";
import { MenuBarAppGrid } from "./components/app-grid";
import {
  AppGridActions,
  InstallAppAction,
  useInstallActive,
} from "./components/install-action";

export default {
  description:
    "The menu-bar panel's app grid (MenuBar.Section 'apps'): every Apps.App with a URL — the current app and surface-mode apps (the desktop) left out — as the compact icons DataView over the installedApp row kind (the tile and name Home and the launcher draw), each tile wearing its app's badge. Four columns, scrolling past four rows; drag reorders it, persisted per view (defineDataView('menu-bar.apps')). A tile opens its app in its own OS window through the helper when it is installed (launchApp), else in the default browser (openUrl), or in this tab when the panel is not inside the helper. On hover a tile offers + (AppGridActions 'install'): installs the app as an OS app through POST /api/menu-bar/install/:appId — hidden once installed (menu-bar.installed) or where the host cannot install (menu-bar.capabilities), a spinner while pending, an error mark when the install failed.",
  contributions: [
    MenuBar.Section({ id: "apps", label: "Apps", component: MenuBarAppGrid }),
    AppGridActions({
      id: "install",
      component: InstallAppAction,
      useActive: useInstallActive,
    }),
  ],
  slots: { itemActions: AppGridActions },
} satisfies PluginDefinition;
