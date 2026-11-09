import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { OpenInWindowRow } from "./components/open-in-window-row";

export default {
  description:
    "Open in app window: a row in the action bar's view-options popover that hands this browser tab's page to the menu-bar helper as an equin://open link, which opens it in the installed app's own macOS window. Shown on macOS only, never inside an app window.",
  contributions: [
    ActionBar.ViewOption({
      id: "open-in-window",
      component: OpenInWindowRow,
    }),
  ],
} satisfies PluginDefinition;
