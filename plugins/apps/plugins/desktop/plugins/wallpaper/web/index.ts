import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { wallpaperConfig } from "../core";
import { Wallpaper } from "./slots";

export { Wallpaper } from "./slots";
export { openWallpaperPicker } from "./components/wallpaper-picker";
export { WallpaperSearchPanel } from "./components/wallpaper-search-panel";
export { DesktopContextMenu } from "./components/desktop-context-menu";
export { WallpaperAttribution } from "./components/wallpaper-attribution";
export { builtinWallpaperUrl } from "./builtin/urls";
export type { WallpaperCandidate } from "../core";

export default {
  description:
    "Floating desktop wallpaper: the Wallpaper.Provider source registry, the picker dialog + shared search panel, the desktop right-click context menu, the corner attribution credit, and the global wallpaper config web registration.",
  contributions: [ConfigV2.WebRegister({ descriptor: wallpaperConfig })],
  slots: Wallpaper,
} satisfies PluginDefinition;
