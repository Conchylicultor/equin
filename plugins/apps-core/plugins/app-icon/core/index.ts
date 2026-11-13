import type { AvatarColor } from "@plugins/primitives/plugins/avatar/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";

/**
 * Canonical, serializable identity of an app's icon. A discriminated union so a
 * custom-image variant (`{ kind: "image"; src }`) drops in later with one render
 * branch and zero changes to existing `kind: "symbol"` authors.
 *
 * `color` is the app's declared tile colour (a launcher paints the icon on it).
 * Omitted, a surface derives one from the app id, so only an app whose colour is
 * part of its identity declares it.
 */
export type AppIcon = {
  kind: "symbol";
  symbol: SymbolRef;
  color?: AvatarColor;
};

export { appIcon } from "./internal/app-icon";
export { APP_TILE_PALETTE } from "./internal/tile-palette";
export { appIconToSvg } from "./internal/app-icon-to-svg";
export type {
  AppIconGlyph,
  AppIconSvgOptions,
} from "./internal/app-icon-to-svg";
export { appTileFill } from "./internal/tile-fill";
