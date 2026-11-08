import type { IconifyJSON } from "@iconify/types";
import {
  deriveActiveForm,
  LUCIDE_ACTIVE_SPRITE,
  LUCIDE_SPRITE,
  lucideActiveId,
  lucideId,
  lucideNameOf,
  placeActiveIds,
  SETI_SPRITE,
  setiId,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import { buildSprite } from "./build-sprite";
import { tuneLucideBody } from "./lucide";

/** The Seti file-type sprite: `seti-<name>` for each of `names` in `set`. */
export function buildSetiSprite(
  set: IconifyJSON,
  names: readonly string[],
): Map<SpriteKey, string> {
  return new Map([
    [
      SETI_SPRITE,
      buildSprite(
        names.map((name) => ({ id: setiId(name), set, iconifyName: name })),
      ),
    ],
  ]);
}

/**
 * The Lucide sprites: under `lucide-<material name>`, the tuned Lucide drawing
 * of every one of `names` `LUCIDE_MAP` gives one, and under
 * `lucide-active-<material name>` (the active sprite) its derived active form
 * — the drawing at rest when it has nothing to fill. A symbol the map does not
 * draw is left out of both — `<Icon>` draws its Material symbol instead.
 */
export function buildLucideSprites(
  set: IconifyJSON,
  names: readonly string[],
): Map<SpriteKey, string> {
  const mapped = names.flatMap((name) => {
    const lucide = lucideNameOf(name);
    return lucide === undefined ? [] : [{ name, lucide }];
  });
  return new Map([
    [
      LUCIDE_SPRITE,
      buildSprite(
        mapped.map(({ name, lucide }) => ({
          id: lucideId(name),
          set,
          iconifyName: lucide,
          tune: tuneLucideBody,
        })),
      ),
    ],
    [
      LUCIDE_ACTIVE_SPRITE,
      buildSprite(
        mapped.map(({ name, lucide }) => ({
          id: lucideActiveId(name),
          set,
          iconifyName: lucide,
          tune: (body) => {
            const tuned = tuneLucideBody(body);
            const active = deriveActiveForm(tuned.body);
            return active === undefined
              ? tuned
              : {
                  ...tuned,
                  body: placeActiveIds(active, lucideActiveId(name)),
                };
          },
        })),
      ),
    ],
  ]);
}
