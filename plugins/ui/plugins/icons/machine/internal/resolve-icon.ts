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
import { readIconSetSync } from "@plugins/ui/plugins/icons/plugins/icon-sets/core";

/**
 * One Material Symbols glyph as SVG markup, for a consumer with no sprite sheet
 * to `<use>` — the release CLI rasterizing an app icon. Reads and parses both
 * icon sets (~19 MB of JSON) synchronously on every call: for a one-shot
 * process only. A backend draws an app's glyph through the sprites' build
 * (`manifestSymbolBody`, sprites/machine), which parsed them once.
 */
export function symbolBody(
  name: SymbolName,
  style: IconStyle = DEFAULT_ICON_STYLE,
): IconBody {
  const sets: SymbolSets = {
    regular: readIconSetSync("@iconify-json/material-symbols"),
    light: readIconSetSync("@iconify-json/material-symbols-light"),
  };
  const { set, iconifyName: drawn } = resolveSymbol(
    sets,
    name,
    styleKeyOf(style, false),
  );
  return resolveIcon(set, drawn);
}
