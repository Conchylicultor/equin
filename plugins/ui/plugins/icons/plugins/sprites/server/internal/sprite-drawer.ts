import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { SpriteKey } from "@plugins/ui/plugins/icons/core";

/** One sprite as a drawer answers it: drawn, or not one this host holds a set for. */
export type DrawnSprite =
  | { readonly kind: "drawn"; readonly markup: string }
  | { readonly kind: "not-drawn-here" };

/**
 * How a host draws the build's sprites (`icons.sprite`): from the icon sets
 * installed on the computer (the desktop, `sprites#machine`: every key), or
 * from sets bundled with a browser host's worker (`plugins/bundled-sprites`:
 * the Seti and Lucide sprites).
 */
export interface SpriteDrawerImpl {
  /**
   * What every sprite this drawer draws is a function of — the names, the
   * sets and their versions, the tuning — served as `icons.sprite-hash` and
   * carried by every `icons.sprite` tuple, so a tab never reads one host's
   * sprite under another's address.
   */
  readonly manifestHash: string;
  /** Sprite `key`, a whole `<svg>…</svg>` of `<symbol>`s. */
  draw(key: SpriteKey): Promise<DrawnSprite>;
}

export const SpriteDrawer = defineHostService<SpriteDrawerImpl>(
  "icons.sprite-drawer",
);
