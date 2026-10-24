import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { menuBarApp } from "../core";
import { MenuBar as MenuBarSlots } from "./slots";
import { MenuBarPanel } from "./components/menu-bar-panel";
import { PanelHeader } from "./components/panel-header";
import { PanelFooter } from "./components/panel-footer";
import { menuBarTheme } from "./internal/theme";

export { MenuBar, type MenuBarStatus } from "./slots";
export { useNativeHost, type NativeHost } from "./native-host";

export default {
  description:
    "The menu-bar panel the native helper opens: the menu-bar app (unlisted, colorMode light — the panel is designed light) mounted at /home/menu-bar, whose whole layout is the panel (no pane; chromeless under ?embed=1), whose body is the MenuBar.Section slot, drawn in its own theme (a native menu's: the system font, 13px rows, a 2–16px spacing ramp, the menu palette), plus the header (the spiral and a status line joined from MenuBar.Status parts, whose attention lights the menu-bar icon's dot) and the footer ('Running · <host>', opening equin). useNativeHost() reads the helper's bridge (window.equinNative): pending, absent (a plain browser), or present with its platform, capabilities and methods — a capability the host lacks has no method. MenuBar.Mount runs headless work while the panel page is alive; the panel reports its content height to the helper.",
  contributions: [
    // Its own app (unlisted, always light), mounted at /home/menu-bar; the
    // panel is its whole layout (no pane, so no pane header behind it).
    Apps.App({ app: menuBarApp, component: MenuBarPanel }),
    // A native menu's look, selected for the menu-bar app in
    // `config/ui/theme-engine/@app/menu-bar/theme.jsonc`.
    ThemeEngine.Theme(menuBarTheme),
    MenuBarSlots.Section({
      id: "header",
      label: "Header",
      component: PanelHeader,
    }),
    MenuBarSlots.Section({
      id: "footer",
      label: "Footer",
      component: PanelFooter,
    }),
  ],
  slots: MenuBarSlots,
} satisfies PluginDefinition;
