import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Browser } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { NavControls } from "./components/nav-controls";

export default {
  description:
    "Browser navigation controls: back / forward / reload buttons in the chrome bar.",
  contributions: [
    Browser.NavControls({ id: "nav-controls", component: NavControls }),
  ],
} satisfies PluginDefinition;
