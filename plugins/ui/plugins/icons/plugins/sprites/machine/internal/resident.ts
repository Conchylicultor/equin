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
 * first load is the only one. Its ETag is `manifestHash` — the hash of exactly
 * what the value is a function of — so a tab replaying it after a restart that
 * changed none of that is answered `up-to-date` instead of re-sent ~1 MB.
 */
export const residentSpritesServed = serveValue(residentSprites, {
  source: "external",
  // `spriteFor`'s per-process memo, built once by the boot snapshot.
  readCost: "memory",
  changes: {
    fixed: {
      reason:
        "a pure function of the manifest compiled into this process and the installed icon sets",
    },
  },
  revalidate: () => Promise.resolve(manifestHash),
  loader: async () => ({
    manifestHash,
    sprites: Object.fromEntries(
      await Promise.all(
        RESIDENT.map(async (key) => [key, await spriteFor(key)] as const),
      ),
    ),
  }),
});
