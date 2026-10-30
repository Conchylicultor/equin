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
    "The menu-bar panel's app grid (MenuBar.Section 'apps'): every Apps.App but the current app and the home app (the desktop included: its URL is its base path as a route prefix) — as the icons DataView over the installedApp row kind, laid out as a menu's grid (viewOptions.icons.menu: four cells sharing the panel's width) (the tile and name Home and the launcher draw), each tile wearing its app's badge, filtered by name as the panel's field is typed (usePanelInput). Scrolling past four rows; drag reorders it, persisted per view (defineDataView('menu-bar.apps')). A tile opens its app in its own OS window through the helper (launchApp) — every app has its shim, kept by the helper ahead of any click (useNativeApps, the helper's installed set); in the default browser (openUrl) only for an app with no shim (a helper that keeps no apps); in this tab when the panel is not inside the helper. On hover a tile offers a pin (AppGridActions 'pin'): keeps the app in the Dock / GNOME dash through the helper's bridge (pinApp — a device power, never the server's) — hidden once pinned (re-read on each panel open, so it follows the Dock itself) or where the helper cannot pin, a spinner while pending, an error mark when the pin failed.",
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
