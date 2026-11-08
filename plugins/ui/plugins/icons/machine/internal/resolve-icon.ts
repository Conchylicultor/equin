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
 * to `<use>` — the release CLI rasterizing an app icon. Reads and parses both
 * icon sets (~19 MB of JSON) on every call: for a one-shot process only. A backend draws an app's glyph through the sprites' build
 * (`manifestSymbolBody`, sprites/machine), which parsed them once.
 */
export async function symbolBody(
  name: SymbolName,
  style: IconStyle = DEFAULT_ICON_STYLE,
): Promise<IconBody> {
  const [regular, light] = await Promise.all([
    readIconSet("@iconify-json/material-symbols"),
    readIconSet("@iconify-json/material-symbols-light"),
  ]);
  const sets: SymbolSets = { regular, light };
  const { set, iconifyName: drawn } = resolveSymbol(
    sets,
    name,
    styleKeyOf(style, false),
  );
  return resolveIcon(set, drawn);
}
