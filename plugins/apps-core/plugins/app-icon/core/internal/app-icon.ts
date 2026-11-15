import type { AppTileColor } from "@plugins/apps-core/plugins/app-icon/plugins/tile-colors/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";
import type { AppIcon } from "../index";

/**
 * Author an app's icon from a Material Symbols glyph:
 * `icon: appIcon(symbol("home"))`, or `appIcon(symbol("settings"), { color: "slate" })`
 * to declare the app's tile colour instead of deriving it from the app id.
 */
export function appIcon(
  symbol: SymbolRef,
  opts: { color?: AppTileColor } = {},
): AppIcon {
  return {
    kind: "symbol",
    symbol,
    ...(opts.color !== undefined && { color: opts.color }),
  };
}
