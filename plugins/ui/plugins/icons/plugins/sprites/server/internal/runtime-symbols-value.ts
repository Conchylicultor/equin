import { serveValue } from "@plugins/network/plugins/live/server";
import {
  glyphId,
  isGlyphKey,
  isStyleKey,
  wrapSprite,
  type GlyphKey,
} from "@plugins/ui/plugins/icons/core";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { MAX_RUNTIME_SYMBOLS_PER_READ, runtimeSymbolsValue } from "../../core";
import { runtimeSymbols, symbolsHash } from "./drawer";
import { SpriteDrawer } from "./sprite-drawer";

/**
 * The hash a glyph tuple of `key` carries: the Material drawer's
 * {@link symbolsHash} for a style key (it never folds the code's manifest,
 * so a new icon in the code re-addresses no Material glyph), the sprite
 * drawer's manifest hash for a Lucide key (its drawings are built from the
 * manifest's Lucide map).
 */
export function glyphHash(key: GlyphKey): string {
  return isStyleKey(key) ? symbolsHash() : SpriteDrawer.get().manifestHash;
}

/**
 * Why a glyph tuple is not one this host answers — `null` when it is. The
 * same verdict for the live value and the head's asset, so the two can never
 * disagree about an address.
 */
export function glyphTupleRefusal(
  hash: string,
  key: string,
  names: readonly string[],
): {
  code: "unknown-key" | "stale-symbols" | "invalid-names";
  message: string;
} | null {
  if (!isGlyphKey(key)) {
    return { code: "unknown-key", message: `No glyph key is named "${key}"` };
  }
  const current = glyphHash(key);
  if (hash !== current) {
    return {
      code: "stale-symbols",
      message: `Glyph version ${hash} of "${key}" is not this server's (${current})`,
    };
  }
  if (names.length === 0 || names.length > MAX_RUNTIME_SYMBOLS_PER_READ) {
    return {
      code: "invalid-names",
      message: `names must hold 1 to ${MAX_RUNTIME_SYMBOLS_PER_READ} names (got ${names.length})`,
    };
  }
  for (let i = 1; i < names.length; i++) {
    if (names[i - 1]! >= names[i]!) {
      return {
        code: "invalid-names",
        message: "names must be sorted and duplicate-free",
      };
    }
  }
  return null;
}

/** Each sprite markup's `<symbol>`s by id, parsed once per markup (one per key a drawer built). */
const symbolsByMarkup = new Map<string, ReadonlyMap<string, string>>();

function symbolsOf(markup: string): ReadonlyMap<string, string> {
  let byId = symbolsByMarkup.get(markup);
  if (byId === undefined) {
    const map = new Map<string, string>();
    // The drawer's own markup: `<symbol>`s never nest, and every resource a
    // symbol uses sits inside it (icons' "Active forms").
    for (const m of markup.matchAll(
      /<symbol\b[^>]*?\sid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g,
    )) {
      map.set(m[1]!, m[0]);
    }
    byId = map;
    symbolsByMarkup.set(markup, byId);
  }
  return byId;
}

/**
 * The glyphs `names` of `key`, as one hidden `<svg>`: a Material style's drawn
 * by the host's runtime-symbol drawer, a Lucide key's picked from the sprite
 * drawer's memoized sprite. A name the host draws no glyph for is left out
 * (the page marks it missing).
 */
export async function drawGlyphs(
  key: GlyphKey,
  names: readonly string[],
): Promise<string> {
  if (isStyleKey(key)) {
    return await runtimeSymbols(key, names.filter(isSavedSymbolName));
  }
  const drawn = await SpriteDrawer.get().draw(key);
  if (drawn.kind === "not-drawn-here") {
    throw new Error(
      `This host holds no icon set to draw the "${key}" glyphs from`,
    );
  }
  const byId = symbolsOf(drawn.markup);
  return wrapSprite(
    names.flatMap((name) => byId.get(glyphId(key, name)) ?? []),
  );
}

/** One glyph batch, refused as the value declares. */
export async function loadRuntimeSymbols({
  hash,
  key,
  names: raw,
}: {
  hash: string;
  key: string;
  names: string;
}): Promise<string> {
  const names = raw === "" ? [] : raw.split(",");
  const refusal = glyphTupleRefusal(hash, key, names);
  if (refusal !== null) {
    throw runtimeSymbolsValue.refuse(refusal.code, refusal.message);
  }
  return await drawGlyphs(key as GlyphKey, names);
}

/**
 * External and `immutable`: this process answers only its own hash per key,
 * and a tuple's glyphs are a pure function of what that hash covers. Its ETag
 * is the tuple itself while `hash` is this process's — so a tab replaying it
 * after a restart that kept the hash is answered `up-to-date` instead of
 * re-sent — and a value no stored ETag can equal otherwise (that tuple is
 * refused `stale-symbols`).
 */
export const runtimeSymbolsServed = serveValue(runtimeSymbolsValue, {
  source: "external",
  // A pick from the drawers' memos (per style on the desktop; the host's
  // store, else the bundled set, on a browser host).
  readCost: "memory",
  changes: {
    immutable: {
      reason:
        "content-addressed by the key's hash (the sets, the drawable-name list, the build versions — and the manifest for a Lucide key) and the sorted names",
    },
  },
  revalidate: ({ hash, key, names }) =>
    Promise.resolve(
      isGlyphKey(key) && hash === glyphHash(key)
        ? `${hash}/${key}/${names}`
        : `stale-symbols/${isGlyphKey(key) ? glyphHash(key) : key}`,
    ),
  loader: loadRuntimeSymbols,
});
