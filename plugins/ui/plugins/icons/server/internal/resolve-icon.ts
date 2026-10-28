import type { IconifyJSON } from "@iconify/types";
import {
  DEFAULT_ICON_STYLE,
  coveredStyles,
  iconifyName,
  parseStyleKey,
  resolveSymbolStyle,
  styleKeyOf,
  type IconStyle,
  type IconWeight,
  type StyleKey,
  type SymbolName,
} from "../../core";
import { readIconSet } from "@plugins/ui/plugins/icons/plugins/icon-sets/core";

/** The drawable part of one Iconify icon. */
export interface IconBody {
  body: string;
  width: number;
  height: number;
}

/**
 * The body of `name` in `set`, following aliases to their parent. An alias
 * that transforms its parent (rotate / flip / a new box) is not drawable as its
 * parent's body, so it throws rather than drawing the wrong glyph; none of the
 * sets we ship has one today.
 */
export function resolveIcon(set: IconifyJSON, name: string): IconBody {
  let current = name;
  for (let depth = 0; depth < 16; depth++) {
    const icon = set.icons[current];
    if (icon) {
      return {
        body: icon.body,
        width: icon.width ?? set.width ?? 16,
        height: icon.height ?? set.height ?? 16,
      };
    }
    const alias = set.aliases?.[current];
    if (!alias) {
      throw new Error(`[icons] "${name}" is not in the ${set.prefix} icon set`);
    }
    const transforms = Object.keys(alias).filter(
      (k) => k !== "parent" && k !== "hidden",
    );
    if (transforms.length > 0) {
      throw new Error(
        `[icons] ${set.prefix}:${current} is an alias with transforms (${transforms.join(", ")}), which the sprite builder does not apply`,
      );
    }
    current = alias.parent;
  }
  throw new Error(`[icons] alias chain too deep at ${set.prefix}:${name}`);
}

/** The two Material Symbols sets, by the weight each draws. */
export type SymbolSets = Readonly<Record<IconWeight, IconifyJSON>>;

function hasIcon(set: IconifyJSON, name: string): boolean {
  return name in set.icons || name in (set.aliases ?? {});
}

/**
 * The Iconify icon that draws `name` in style `styleKey`: the style itself when
 * the name exists there, else the nearest one that has it
 * (`resolveSymbolStyle`).
 */
export function resolveSymbol(
  sets: SymbolSets,
  name: string,
  styleKey: StyleKey,
): { set: IconifyJSON; iconifyName: string } {
  const covered = coveredStyles(name, (weight, n) => hasIcon(sets[weight], n));
  if (covered.length === 0) {
    throw new Error(`[icons] "${name}" is in neither Material Symbols set`);
  }
  const { shape, fill, weight } = parseStyleKey(
    resolveSymbolStyle(covered, styleKey),
  );
  return { set: sets[weight], iconifyName: iconifyName(name, shape, fill) };
}

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
