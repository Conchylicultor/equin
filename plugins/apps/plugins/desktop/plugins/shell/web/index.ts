import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { desktopTheme } from "./internal/theme";
import { ConfigV2 } from "@plugins/config_v2/web";
import { desktopApp, DESKTOP_PLACEMENT_ID, shelfConfig } from "../core";

export { isDesktopActive, useDesktopActive } from "./internal/desktop-mode";
export { desktopThemeScope } from "./internal/theme-scope";
export { DesktopAppTile } from "./components/desktop-app-tile";

export default {
  description:
    "App shell for the Desktop: its identity, its entry in the app launchers (which switches the surface to the desktop mode instead of opening a tab) its own theme, which the desktop app selects, and the desktop's global shelf config (the apps kept in the dock).",
  contributions: [
    Apps.App({
      app: desktopApp,
      icon: appIcon(symbol("desktop-windows")),
      surfaceMode: DESKTOP_PLACEMENT_ID,
    }),
    // The desktop chrome's theme, selected for the desktop app in
    // `config/ui/theme-engine/@app/desktop/theme.jsonc`.
    ThemeEngine.Theme(desktopTheme),
    // The desktop's global shelf settings (the apps kept in the dock), read
    // and written by the shelf and the launcher.
    ConfigV2.WebRegister({ descriptor: shelfConfig }),
  ],
} satisfies PluginDefinition;
