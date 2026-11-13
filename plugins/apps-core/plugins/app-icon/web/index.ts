import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { AppIconView } from "./components/app-icon-view";
export { AppIconAvatar, AppIconTile } from "./components/app-icon-tile";
export { DEFAULT_APP_ICON } from "./internal/app-icon";

export default {
  description:
    "Canonical, serializable app-icon descriptor (a Material Symbols glyph now, image variant later), drawn by the icons primitive.",
  contributions: [],
} satisfies PluginDefinition;
