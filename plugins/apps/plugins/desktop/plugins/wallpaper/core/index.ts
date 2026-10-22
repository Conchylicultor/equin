export {
  wallpaperConfig,
  WallpaperAttributionSchema,
  WallpaperResultSchema,
  SavedWallpaperSchema,
} from "./config";
export {
  BUILTIN_WALLPAPERS,
  DEFAULT_WALLPAPER_ID,
  GRADIENT_WALLPAPER_ID,
  getBuiltinWallpaper,
  isDefaultWallpaper,
} from "./builtin";
export type { BuiltinWallpaper } from "./builtin";
export type {
  WallpaperAttribution,
  WallpaperResult,
  SavedWallpaper,
} from "./config";
export {
  importWallpaperUrl,
  uploadWallpaper,
  wallpaperImage,
} from "./endpoints";
export type { WallpaperCandidate } from "./endpoints";
export { wallpaperSearch, WALLPAPER_QUERY_MAX } from "./resources";
