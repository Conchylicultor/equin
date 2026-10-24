import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { MenuBar } from "@plugins/menu-bar/web";
import { MenuBarAppGrid } from "./components/app-grid";
import {
  AppGridActions,
  PinAppAction,
  usePinActive,
} from "./components/pin-action";

export default {
  description:
    "The menu-bar panel's app grid (MenuBar.Section 'apps'): every Apps.App but the current app and the home app (the desktop included: its URL is its base path as a route prefix) — as the icons DataView over the installedApp row kind, laid out as a menu's grid (viewOptions.icons.menu: four cells sharing the panel's width) (the tile and name Home and the launcher draw), each tile wearing its app's badge. Scrolling past four rows; drag reorders it, persisted per view (defineDataView('menu-bar.apps')). A tile opens its app in its own OS window through the helper (launchApp) — every app has its shim, kept by main ahead of any click (menu-bar.installed); in the default browser (openUrl) only for an app whose shim is not written yet; in this tab when the panel is not inside the helper. On hover a tile offers a pin (AppGridActions 'pin'): keeps the app in the Dock / GNOME dash through POST /api/menu-bar/pin/:appId — hidden once pinned (menu-bar.pinned, which follows the Dock itself) or where the host cannot pin (menu-bar.capabilities), a spinner while pending, an error mark when the pin failed.",
  contributions: [
    MenuBar.Section({ id: "apps", label: "Apps", component: MenuBarAppGrid }),
    AppGridActions({
      id: "pin",
      component: PinAppAction,
      useActive: usePinActive,
    }),
  ],
  slots: { itemActions: AppGridActions },
} satisfies PluginDefinition;
