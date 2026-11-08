import { createHash } from "crypto";
import type { IconifyJSON } from "@iconify/types";
import {
  ACTIVE_FORM_VERSION,
  ALL_STYLE_KEYS,
  BRANDS_SPRITE,
  DEFAULT_ICON_STYLE,
  LUCIDE_ACTIVE_SPRITE,
  LUCIDE_MAP,
  LUCIDE_SPRITE,
  SETI_SPRITE,
  brandId,
  resolveIcon,
  resolveSymbol,
  styleKeyOf,
  symbolId,
  type IconBody,
  type SpriteKey,
  type SymbolName,
  type SymbolSets,
} from "@plugins/ui/plugins/icons/core";
import { SETI_SET, readSetiSet } from "@plugins/ui/plugins/icons/server";
import {
  buildLucideSprites,
  buildSetiSprite,
  buildSprite,
  LUCIDE_TUNING_VERSION,
  type SpriteDrawerImpl,
} from "../../server";
import { ICON_MANIFEST } from "./icon-manifest.generated";
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
 * The Seti file-type sprite, for the manifest's Seti names. Never resident
 * (see `resident.ts`): fetched the first time a Seti icon mounts, so it costs
 * nothing until a file is shown.
 */
async function setiSprite(): Promise<Map<SpriteKey, string>> {
  const set =
    ICON_MANIFEST.seti.length === 0
      ? { prefix: "seti", icons: {} }
      : await readSetiSet();
  return buildSetiSprite(set, ICON_MANIFEST.seti);
}

/**
 * The Lucide sprites, for every manifest symbol `LUCIDE_MAP` draws. Never
 * resident: each is fetched the first time an icon (an active one) in a
 * Lucide scope mounts.
 */
async function lucideSprite(): Promise<Map<SpriteKey, string>> {
  return buildLucideSprites(
    await readSet(PACKAGE.lucide),
    ICON_MANIFEST.symbols,
  );
}

/**
 * All 12 symbol sprites, for the manifest's names. Under `ms-<K>-<name>` each
 * holds the drawing `resolveSymbol` picks for style K — the style's own, or
 * its nearest fallback — so `<Icon>` needs no fallback of its own.
 *
 * And, from the same pass over the same parsed sets, each manifest symbol's
 * glyph in the default style at rest as a bare body ({@link manifestSymbolBody}):
 * what a consumer with no sprite sheet draws (an app's OS icon).
 */
function symbolSprites(sets: SymbolSets): SetBuild {
  const sprites = new Map<SpriteKey, string>();
  for (const styleKey of ALL_STYLE_KEYS) {
    sprites.set(
      styleKey,
      buildSprite(
        ICON_MANIFEST.symbols.map((name) => ({
          id: symbolId(styleKey, name),
          ...resolveSymbol(sets, name, styleKey),
        })),
      ),
    );
  }
  const rest = styleKeyOf(DEFAULT_ICON_STYLE, false);
  const bodies = new Map<string, IconBody>(
    ICON_MANIFEST.symbols.map((name) => {
      const { set, iconifyName } = resolveSymbol(sets, name, rest);
      return [name, resolveIcon(set, iconifyName)];
    }),
  );
  return { sprites, bodies };
}

/** What one set group's build yields: its sprites, and for the symbols the default style's bare glyphs. */
interface SetBuild {
  sprites: Map<SpriteKey, string>;
  bodies?: ReadonlyMap<string, IconBody>;
}

// One build per sprite group per process, memoized: the ~10 MB sets are
// parsed once, every sprite they yield is kept (a few hundred KB), and the
// parsed sets are dropped. The manifest and node_modules cannot change under a
// running process.
const builds = new Map<SetKey, Promise<SetBuild>>();

async function loadSet(key: SetKey): Promise<SetBuild> {
  if (key === BRANDS_SPRITE) {
    // No brand is drawn: nothing to parse the 5 MB brand set for.
    if (ICON_MANIFEST.brands.length === 0) {
      return { sprites: brandSprite({ prefix: "simple-icons", icons: {} }) };
    }
    return { sprites: brandSprite(await readSet(PACKAGE.brands)) };
  }
  if (key === SETI_SPRITE) return { sprites: await setiSprite() };
  if (key === LUCIDE_SPRITE) return { sprites: await lucideSprite() };
  return await withSymbolSets(symbolSprites);
}

function buildOf(setKey: SetKey): Promise<SetBuild> {
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
  return build;
}

export async function spriteFor(key: SpriteKey): Promise<string> {
  const setKey = setOf(key);
  const sprite = (await buildOf(setKey)).sprites.get(key);
  if (sprite === undefined) {
    throw new Error(
      `[icons] sprite "${key}" was not built from set "${setKey}"`,
    );
  }
  return sprite;
}

/**
 * One manifest symbol's glyph in the default style at rest — the drawing the
 * resident sprite holds under its id — as a bare body. Read from the symbol
 * sprites' build (the sets parsed once per process, with every sprite), never
 * by parsing the sets again. Throws for a name the manifest does not hold: an
 * app's icon is a `symbol("…")` literal, so the build scanned it.
 */
export async function manifestSymbolBody(name: SymbolName): Promise<IconBody> {
  const body = (await buildOf("symbols")).bodies?.get(name);
  if (body === undefined) {
    throw new Error(
      `[icons] "${name}" is not in the icon manifest — only a symbol("…") literal the build scanned has a drawing here`,
    );
  }
  return body;
}

/** The desktop's sprite drawer: every key, from the installed sets. */
export const installedSetsSpriteDrawer: SpriteDrawerImpl = {
  manifestHash,
  draw: async (key) => ({ kind: "drawn", markup: await spriteFor(key) }),
};
