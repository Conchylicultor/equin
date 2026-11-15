import {
  appTileColor,
  appTileStops,
  type OklchColor,
} from "@plugins/apps-core/plugins/app-icon/plugins/tile-colors/core";
import { Color } from "@plugins/primitives/plugins/css/plugins/color-picker/core";
import type { AppIcon } from "../index";

function hex({ l, c, h }: OklchColor): string {
  return Color.fromOklch(l, c, h).fitted().toHex();
}

/**
 * The colour an app's tile is, as one sRGB hex — its gradient's base, for a
 * painter that takes a single colour (a web-app manifest's theme colour, the
 * island's building hue). The same pick the tile makes: the app's declared
 * colour, else one picked from its id.
 */
export function appTileFill(icon: AppIcon, appId: string): string {
  return hex(appTileStops(appTileColor(icon.color, appId)).base);
}

/** The tile's gradient as two sRGB hex stops (deep end top-left, base bottom-right) — for a rasterizer with no CSS (the icon PNGs). */
export function appTileGradient(
  icon: AppIcon,
  appId: string,
): { from: string; to: string } {
  const { deep, base } = appTileStops(appTileColor(icon.color, appId));
  return { from: hex(deep), to: hex(base) };
}
