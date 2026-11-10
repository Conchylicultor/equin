import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { AppsLayout } from "./components/apps-layout";

export default {
  description:
    "Apps layout: the Core.Root composition wiring the tab bar, rail framing, and surface together, with the default-app redirect and document-title sync.",
  loadBearing: true,
  contributions: [Core.Root({ component: AppsLayout, scope: "page" })],
} satisfies PluginDefinition;
