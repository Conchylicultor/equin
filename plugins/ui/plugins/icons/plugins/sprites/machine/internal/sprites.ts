import { createHash } from "crypto";
import type { IconifyJSON } from "@iconify/types";
import {
  ACTIVE_FORM_VERSION,
  ALL_STYLE_KEYS,
  BRANDS_SPRITE,
  LUCIDE_ACTIVE_SPRITE,
  LUCIDE_MAP,
  LUCIDE_SPRITE,
  SETI_SPRITE,
  brandId,
  deriveActiveForm,
  lucideActiveId,
  lucideId,
  placeActiveIds,
  lucideNameOf,
  setiId,
  symbolId,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import {
  SETI_SET,
  readSetiSet,
  resolveSymbol,
  type SymbolSets,
} from "@plugins/ui/plugins/icons/server";
import { buildSprite } from "./build-sprite";
import { ICON_MANIFEST } from "./icon-manifest.generated";
import { LUCIDE_TUNING_VERSION, tuneLucideBody } from "./lucide";
import { PACKAGE, setIdentity, readSet, withSymbolSets } from "./symbol-sets";

/**
 * Where each sprite's glyphs come from. Every symbol sprite is built from BOTH
 * Material Symbols sets: a style that lacks a name draws the nearest style that
 * has it, which may be the other weight. Brands and Seti are one sprite each;
 * Lucide builds its sprite and its active sprite together.
 */
type SetKey =
  "symbols" | typeof BRANDS_SPRITE | typeof SETI_SPRITE | typeof LUCIDE_SPRITE;

function setOf(key: SpriteKey): SetKey {
  if (key === LUCIDE_ACTIVE_SPRITE) return LUCIDE_SPRITE;
  return key === BRANDS_SPRITE || key === SETI_SPRITE || key === LUCIDE_SPRITE
    ? key
    : "symbols";
}

/**
 * What every sprite is a function of — the manifest, the installed sets'
 * versions, the Lucide map, its tuning and the active-form derivation — so a
 * URL carrying it can be cached forever.
 */
export const manifestHash: string = createHash("sha256")
  .update(JSON.stringify(ICON_MANIFEST))
  .update(JSON.stringify(LUCIDE_MAP))
  .update(LUCIDE_TUNING_VERSION)
  .update(ACTIVE_FORM_VERSION)
  .update([...Object.values(PACKAGE), SETI_SET].map(setIdentity).join("\n"))
  .digest("hex")
  .slice(0, 16);
function brandSprite(brands: IconifyJSON): Map<SpriteKey, string> {
  return new Map([
    [
      BRANDS_SPRITE,
      buildSprite(
        ICON_MANIFEST.brands.map((name) => ({
          id: brandId(name),
          set: brands,
          iconifyName: name,
        })),
      ),
    ],
  ]);
}

/**
 * The Seti file-type sprite. Never resident (see `resident.ts`): fetched the
 * first time a Seti icon mounts, so it costs nothing until a file is shown.
 */
async function setiSprite(): Promise<Map<SpriteKey, string>> {
  const set =
    ICON_MANIFEST.seti.length === 0
      ? { prefix: "seti", icons: {} }
      : await readSetiSet();
  return new Map([
    [
      SETI_SPRITE,
      buildSprite(
        ICON_MANIFEST.seti.map((name) => ({
          id: setiId(name),
          set,
          iconifyName: name,
        })),
      ),
    ],
  ]);
}

/**
 * The Lucide sprites: under `lucide-<material name>`, the tuned Lucide drawing
 * of every manifest symbol `LUCIDE_MAP` gives one, and under
 * `lucide-active-<material name>` (the active sprite) its derived active form
 * — the drawing at rest when it has nothing to fill. A symbol the map does not
 * draw is left out of both — `<Icon>` draws its Material symbol instead.
 * Never resident: each is fetched the first time an icon (an active one) in a
 * Lucide scope mounts.
 */
async function lucideSprite(): Promise<Map<SpriteKey, string>> {
  const set = await readSet(PACKAGE.lucide);
  const mapped = ICON_MANIFEST.symbols.flatMap((name) => {
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

/**
 * All 12 symbol sprites, for the manifest's names. Under `ms-<K>-<name>` each
 * holds the drawing `resolveSymbol` picks for style K — the style's own, or
 * its nearest fallback — so `<Icon>` needs no fallback of its own.
 */
function symbolSprites(sets: SymbolSets): Map<SpriteKey, string> {
  const out = new Map<SpriteKey, string>();
  for (const styleKey of ALL_STYLE_KEYS) {
    out.set(
      styleKey,
      buildSprite(
        ICON_MANIFEST.symbols.map((name) => ({
          id: symbolId(styleKey, name),
          ...resolveSymbol(sets, name, styleKey),
        })),
      ),
    );
  }
  return out;
}

// One build per sprite group per process, memoized: the ~10 MB sets are
// parsed once, every sprite they yield is kept (a few hundred KB), and the
// parsed sets are dropped. The manifest and node_modules cannot change under a
// running process.
const builds = new Map<SetKey, Promise<Map<SpriteKey, string>>>();

async function loadSet(key: SetKey): Promise<Map<SpriteKey, string>> {
  if (key === BRANDS_SPRITE) {
    // No brand is drawn: nothing to parse the 5 MB brand set for.
    if (ICON_MANIFEST.brands.length === 0) {
      return brandSprite({ prefix: "simple-icons", icons: {} });
    }
    return brandSprite(await readSet(PACKAGE.brands));
  }
  if (key === SETI_SPRITE) return await setiSprite();
  if (key === LUCIDE_SPRITE) return await lucideSprite();
  return await withSymbolSets(symbolSprites);
}

export async function spriteFor(key: SpriteKey): Promise<string> {
  const setKey = setOf(key);
  let build = builds.get(setKey);
  if (!build) {
    // A failed build is not cached: the next request retries (and fails
    // loudly again). The rejection still reaches this caller.
    build = loadSet(setKey).catch((err: unknown) => {
      builds.delete(setKey);
      throw err;
    });
    builds.set(setKey, build);
  }
  const sprite = (await build).get(key);
  if (sprite === undefined) {
    throw new Error(
      `[icons] sprite "${key}" was not built from set "${setKey}"`,
    );
  }
  return sprite;
}
