import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  BRANDS_SPRITE,
  DEFAULT_STYLE_KEYS,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import { residentSprites } from "../../core";
import { manifestHash, spriteFor } from "./sprites";

// Not the Seti sprite: file-type glyphs are fetched on demand, the first time
// one mounts, so surfaces that never show a file pay nothing at boot.
const RESIDENT: readonly SpriteKey[] = [...DEFAULT_STYLE_KEYS, BRANDS_SPRITE];

/**
 * The resident sprites. External and `fixed` (no `notify`): a pure function of
 * the manifest compiled into this process and the installed icon sets, so the
 * first load is the only one.
 */
export const residentSpritesServed = serveValue(residentSprites, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a pure function of the manifest compiled into this process and the installed icon sets",
    },
  },
  loader: async () => ({
    manifestHash,
    sprites: Object.fromEntries(
      await Promise.all(
        RESIDENT.map(async (key) => [key, await spriteFor(key)] as const),
      ),
    ),
  }),
});
