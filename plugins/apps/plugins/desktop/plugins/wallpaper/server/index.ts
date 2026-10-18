import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import {
  wallpaperConfig,
  searchWallpaper,
  importWallpaperUrl,
  uploadWallpaper,
  wallpaperImage,
} from "../core";
import { handleSearch } from "./internal/handle-search";
import { handleImportUrl } from "./internal/handle-import-url";
import { handleUpload } from "./internal/handle-upload";
import { handleImage } from "./internal/handle-image";

export {
  defineWallpaperProvider,
  getWallpaperProvider,
} from "./internal/registry";
export type { WallpaperSearchProvider } from "./internal/registry";

export default {
  description:
    "Floating desktop wallpaper: provider registry, search/import/upload endpoints, the machine-global wallpaper store, and the global wallpaper config registration.",
  contributions: [ConfigV2.Register({ descriptor: wallpaperConfig })],
  httpRoutes: {
    [searchWallpaper.route]: handleSearch,
    [importWallpaperUrl.route]: handleImportUrl,
    [uploadWallpaper.route]: handleUpload,
    [wallpaperImage.route]: handleImage,
  },
} satisfies ServerPluginDefinition;
