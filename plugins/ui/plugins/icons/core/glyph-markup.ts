import type { IconifyJSON } from "@iconify/types";
import { coveredStyles, resolveSymbolStyle } from "./fallback";
import {
  iconifyName,
  parseStyleKey,
  type IconWeight,
  type StyleKey,
} from "./style";

// Iconify JSON → `<symbol>` markup, pure: every host draws a glyph the same
// way, whether it read the sets off disk (the desktop) or was handed them (a
// browser host's bundled set).

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

/** One sprite entry: its sprite id and the Iconify icon (in which set) drawn under it. */
export interface SpriteEntry {
  id: string;
  set: IconifyJSON;
  iconifyName: string;
  /** Rewrites the resolved body before it is wrapped (the Lucide tuning). */
  tune?: (body: IconBody) => IconBody;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** One `<symbol id viewBox>` drawing the Iconify icon `iconifyName` of `set`. */
export function buildSymbol(entry: SpriteEntry): string {
  const resolved = resolveIcon(entry.set, entry.iconifyName);
  const { body, width, height } = entry.tune?.(resolved) ?? resolved;
  return `<symbol id="${escapeAttr(entry.id)}" viewBox="0 0 ${width} ${height}">${body}</symbol>`;
}

/** A hidden `<svg>` holding already-built `<symbol>`s. */
export function wrapSprite(symbols: readonly string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>`;
}
