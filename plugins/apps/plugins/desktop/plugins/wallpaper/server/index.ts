import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { wallpaperConfig, uploadWallpaper, wallpaperImage } from "../core";
import { wallpaperSearchServed } from "./internal/search-served";
import { handleUpload } from "./internal/handle-upload";
import { handleImage } from "./internal/handle-image";

export {
  defineWallpaperProvider,
  getWallpaperProvider,
} from "./internal/registry";
export type { WallpaperSearchProvider } from "./internal/registry";
export { desktopFiles } from "./internal/roots";
export { writeWallpaper } from "./internal/store";

export default {
  description:
    "Floating desktop wallpaper, on every host: provider registry, the live wallpaper.search value, the upload endpoint and image route over the wallpaper store (a data-files root, desktopFiles: the computer's disk on the desktop, memory in a browser host), and the global wallpaper config registration. Importing from a link is the machine half's.",
  contributions: [
    ConfigV2.Register({ descriptor: wallpaperConfig }),
    ...wallpaperSearchServed.declare,
  ],
  httpRoutes: {
    [uploadWallpaper.route]: handleUpload,
    [wallpaperImage.route]: handleImage,
  },
} satisfies ServerPluginDefinition;
