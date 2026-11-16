import type { AvatarColor } from "@plugins/primitives/plugins/avatar/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";
import type { AppIcon } from "../index";

/**
 * Author an app's icon from a Material Symbols glyph:
 * `icon: appIcon(symbol("home"))`, or `appIcon(symbol("settings"), { color: "slate" })`
 * to declare the app's tile colour instead of deriving it from the app id.
 */
export function appIcon(
  symbol: SymbolRef,
  opts: { color?: AvatarColor } = {},
): AppIcon {
  return {
    kind: "symbol",
    symbol,
    ...(opts.color !== undefined && { color: opts.color }),
  };
}
