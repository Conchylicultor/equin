import {
  APP_TILE_INTENSITIES,
  DEFAULT_APP_TILE_INTENSITY,
} from "@plugins/apps-core/plugins/app-icon/plugins/tile-colors/core";
import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

/**
 * The app tiles' paint, per theme. `appTileIntensity` scales every tile
 * colour's chroma (`AppIconTile` reads `--app-tile-intensity`): the colours
 * themselves are the app's (`tile-colors`), a theme only says how loud they
 * are where it is worn — calm on equin's launchers, vivid on the website.
 */
export const appTileGroup = defineTokenGroup("app-tile", {
  appTileIntensity: {
    default: DEFAULT_APP_TILE_INTENSITY,
    darkDefault: DEFAULT_APP_TILE_INTENSITY,
    label: "App tile colour intensity",
    values: APP_TILE_INTENSITIES,
  },
});
