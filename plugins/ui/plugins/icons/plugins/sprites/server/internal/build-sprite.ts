import {
  buildSymbol,
  wrapSprite,
  type SpriteEntry,
} from "@plugins/ui/plugins/icons/core";

/**
 * One sprite: a hidden `<svg>` holding a `<symbol id viewBox>` per entry. Each
 * entry names its sprite id and the Iconify icon (in which set) drawn under
 * it — for a symbol, the style's own drawing or its nearest fallback.
 */
export function buildSprite(entries: readonly SpriteEntry[]): string {
  return wrapSprite(entries.map(buildSymbol));
}
