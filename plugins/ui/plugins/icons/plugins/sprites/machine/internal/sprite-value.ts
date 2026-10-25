import { serveValue } from "@plugins/network/plugins/live/machine";
import { isSpriteKey } from "@plugins/ui/plugins/icons/core";
import { iconSprite } from "../../core";
import { manifestHash, spriteFor } from "./sprites";

/**
 * One sprite on demand, content-addressed by the manifest hash: external and
 * `immutable` — this process answers only its own hash, and the sprite is a
 * pure function of that manifest and the installed icon sets (`spriteFor`
 * memoizes each set's build, so a key is built once per process).
 */
export const iconSpriteServed = serveValue(iconSprite, {
  source: "external",
  changes: {
    immutable: {
      reason: "content-addressed by the manifest hash",
    },
  },
  loader: async ({ hash, key }) => {
    if (hash !== manifestHash) {
      throw iconSprite.refuse(
        "stale-manifest",
        `Sprite version ${hash} is not this server's (${manifestHash}); reload the page`,
      );
    }
    if (!isSpriteKey(key)) {
      throw iconSprite.refuse("unknown-key", `No sprite is named "${key}"`);
    }
    return await spriteFor(key);
  },
});
