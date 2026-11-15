import type { AppTileColor } from "@plugins/apps-core/plugins/app-icon/plugins/tile-colors/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";

/**
 * Canonical, serializable identity of an app's icon. A discriminated union so a
 * custom-image variant (`{ kind: "image"; src }`) drops in later with one render
 * branch and zero changes to existing `kind: "symbol"` authors.
 *
 * `color` is the app's declared tile colour (`AppTileColor`: a launcher paints
 * the icon on its gradient). Omitted, a surface picks one from the app id.
 */
export type AppIcon = {
  kind: "symbol";
  symbol: SymbolRef;
  color?: AppTileColor;
};

export { appIcon } from "./internal/app-icon";
export { appIconToSvg } from "./internal/app-icon-to-svg";
export type {
  AppIconGlyph,
  AppIconSvgOptions,
} from "./internal/app-icon-to-svg";
export { appTileFill, appTileGradient } from "./internal/tile-fill";
