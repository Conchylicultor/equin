import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Apps } from "@plugins/apps-core/web";
import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { menuBarApp } from "../core";
import { MenuBar as MenuBarSlots } from "./slots";
import { menuBarPane } from "./components/menu-bar-panel";
import { PanelHeader } from "./components/panel-header";
import { PanelFooter } from "./components/panel-footer";

export { MenuBar, type MenuBarStatus } from "./slots";
export { useNativeHost, type NativeHost } from "./native-host";

export default {
  description:
    "The menu-bar panel the native helper opens: the menu-bar app (unlisted, colorMode system — it follows the OS light/dark) mounted at /home/menu-bar, whose index pane is the panel (rendered chromeless under ?embed=1), whose body is the MenuBar.Section slot, plus the header (the spiral and a status line joined from MenuBar.Status parts, whose attention lights the menu-bar icon's dot) and the footer ('Running · <host>', opening equin). useNativeHost() reads the helper's bridge (window.equinNative): pending, absent (a plain browser), or present with its platform, capabilities and methods — a capability the host lacks has no method. MenuBar.Mount runs headless work while the panel page is alive; the panel reports its content height to the helper.",
  contributions: [
    // Its own app (unlisted, following the OS's light/dark), mounted at
    // /home/menu-bar; the panel pane is its index.
    Apps.App({ app: menuBarApp, component: FullPane }),
    Pane.Register({ pane: menuBarPane }),
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
  slots: { ...MenuBarSlots, panel: menuBarPane },
} satisfies PluginDefinition;
