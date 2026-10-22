import { createHash } from "crypto";
import type { IconifyJSON } from "@iconify/types";
import {
  ALL_STYLE_KEYS,
  BRANDS_SPRITE,
  LUCIDE_MAP,
  LUCIDE_SPRITE,
  SETI_SPRITE,
  brandId,
  lucideId,
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
 * has it, which may be the other weight. Brands, Seti and Lucide are one
 * sprite each.
 */
type SetKey =
  "symbols" | typeof BRANDS_SPRITE | typeof SETI_SPRITE | typeof LUCIDE_SPRITE;

function setOf(key: SpriteKey): SetKey {
  return key === BRANDS_SPRITE || key === SETI_SPRITE || key === LUCIDE_SPRITE
    ? key
    : "symbols";
}

/**
 * What every sprite is a function of — the manifest, the installed sets'
 * versions, the Lucide map and its tuning — so a URL carrying it can be cached
 * forever.
 */
export const manifestHash: string = createHash("sha256")
  .update(JSON.stringify(ICON_MANIFEST))
  .update(JSON.stringify(LUCIDE_MAP))
  .update(LUCIDE_TUNING_VERSION)
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
 * The Lucide sprite: under `lucide-<material name>`, the tuned Lucide drawing
 * of every manifest symbol `LUCIDE_MAP` gives one. A symbol it does not is
 * left out — `<Icon>` draws its Material symbol instead. Never resident:
 * fetched the first time an icon in a Lucide scope mounts.
 */
async function lucideSprite(): Promise<Map<SpriteKey, string>> {
  const set = await readSet(PACKAGE.lucide);
  return new Map([
    [
      LUCIDE_SPRITE,
      buildSprite(
        ICON_MANIFEST.symbols.flatMap((name) => {
          const lucide = lucideNameOf(name);
          return lucide === undefined
            ? []
            : [
                {
                  id: lucideId(name),
                  set,
                  iconifyName: lucide,
                  tune: tuneLucideBody,
                },
              ];
        }),
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
