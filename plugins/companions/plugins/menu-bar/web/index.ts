import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { CompanionHeader } from "@plugins/companions/plugins/panel/web";
import { menuBarApp } from "../core";
import { MenuBar as MenuBarSlots } from "./slots";
import { MenuBarPanel } from "./components/menu-bar-panel";
import { PanelFooter } from "./components/panel-footer";

export { MenuBar } from "./slots";
export { useNativeHost, type NativeHost } from "./native-host";
export { useNativeApps, type NativeAppsState } from "./native-apps";

export default {
  description:
    "The menu-bar panel the native helper opens: the menu-bar app (unlisted, colorMode system — light or dark with the OS, in the companions' `companion` theme) mounted at /home/menu-bar, whose whole layout is the companions' panel (no pane; chromeless under ?embed=1) over the MenuBar.Section slot, with the companions' header (whose Companion.Status attention lights the menu-bar icon's dot) and footer ('Running · <host>', opening equin in the default browser through the helper). useNativeHost() reads the helper's bridge (window.equinNative): pending, absent (a plain browser), or present with its platform, capabilities and methods — a capability the host lacks has no method. useNativeApps() reads the device's installed and pinned apps from the helper that keeps them (pending / unavailable / ready / error), re-read on panel focus and after a pin. MenuBar.Mount runs headless work while the panel page is alive; the panel reports its content height to the helper, shows no toasts, and reloads itself while hidden once main serves a newer web bundle.",
  contributions: [
    // Its own app (unlisted, following the OS scheme), mounted at
    // /home/menu-bar; the panel is its whole layout (no pane, so no pane
    // header behind it).
    Apps.App({ app: menuBarApp, component: MenuBarPanel }),
    MenuBarSlots.Section({
      id: "header",
      label: "Header",
      component: CompanionHeader,
    }),
    MenuBarSlots.Section({
      id: "footer",
      label: "Footer",
      component: PanelFooter,
    }),
  ],
  slots: MenuBarSlots,
} satisfies PluginDefinition;
