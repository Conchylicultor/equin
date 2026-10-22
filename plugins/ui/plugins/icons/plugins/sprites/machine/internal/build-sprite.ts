import type { IconifyJSON } from "@iconify/types";
import { resolveIcon, type IconBody } from "@plugins/ui/plugins/icons/server";

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

/**
 * One sprite: a hidden `<svg>` holding a `<symbol id viewBox>` per entry. Each
 * entry names its sprite id and the Iconify icon (in which set) drawn under
 * it — for a symbol, the style's own drawing or its nearest fallback.
 */
export function buildSprite(entries: readonly SpriteEntry[]): string {
  return wrapSprite(entries.map(buildSymbol));
}
