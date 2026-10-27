import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import {
  FloatingActionBarHost,
  DockedActionBarHost,
} from "./components/global-action-bar";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { actionBarConfig } from "../shared/config";
import { ViewOptionsButton } from "./components/view-options-button";

export { useActionBarPinned } from "./internal/use-action-bar-pinned";

export default {
  description:
    "Global action bar rendering the shared ActionBar.Item set on every app, with two mutually-exclusive mount points keyed on the surface mode: a docked right-aligned strip in the tab bar (Apps.TabBarActions) in desktop and tab modes, and a floating top-right overlay (Core.Root) in fullscreen (solo), where the tab bar is hidden.",
  contributions: [
    Core.Root({ component: FloatingActionBarHost }),
    Apps.TabBarActions({
      id: "global-action-bar",
      // Pinned last in the tab bar's actions, whatever the layout says.
      excludeFromReorder: true,
      component: DockedActionBarHost,
    }),
    // The gear (view options + the pin switch) is an ordinary action, so the
    // slot's order places it like every other button.
    ActionBar.Item({ id: "view-options", component: ViewOptionsButton }),
    ConfigV2.WebRegister({ descriptor: actionBarConfig }),
  ],
} satisfies PluginDefinition;
