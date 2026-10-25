import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Browser } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { TabStrip } from "./components/tab-strip";

export default {
  description:
    "Browser tab strip: an in-app row of tabs, each a page in the engine's Chromium showing its title and favicon, with a new-tab button. Renders above the chrome bar.",
  contributions: [Browser.TabStrip({ id: "tab-strip", component: TabStrip })],
} satisfies PluginDefinition;
