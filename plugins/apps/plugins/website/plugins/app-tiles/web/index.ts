import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { WebsiteAppTile } from "./components/website-app-tile";

export default {
  description:
    "The website's app tile: <WebsiteAppTile symbol color />, an app's glyph on its vivid website colour as a diagonal gradient on a bounded squircle.",
} satisfies PluginDefinition;
