import {
  DEFAULT_ICON_STYLE,
  resolveIcon,
  resolveSymbol,
  styleKeyOf,
  type IconBody,
  type IconStyle,
  type SymbolName,
  type SymbolSets,
} from "../../core";
import { readIconSet } from "@plugins/ui/plugins/icons/plugins/icon-sets/core";

/**
 * One Material Symbols glyph as SVG markup, for a consumer with no sprite sheet
 * to `<use>` — the release CLI rasterizing an app icon. Reads both icon sets
 * synchronously on every call; not for a request path.
 */
export function symbolBody(
  name: SymbolName,
  style: IconStyle = DEFAULT_ICON_STYLE,
): IconBody {
  const sets: SymbolSets = {
    regular: readIconSet("@iconify-json/material-symbols"),
    light: readIconSet("@iconify-json/material-symbols-light"),
  };
  const { set, iconifyName: drawn } = resolveSymbol(
    sets,
    name,
    styleKeyOf(style, false),
  );
  return resolveIcon(set, drawn);
}
