import { createHash } from "crypto";
import { runtimeSymbolId, type StyleKey } from "@plugins/ui/plugins/icons/core";
import { resolveSymbol } from "@plugins/ui/plugins/icons/server";
import { allSavedSymbolNames } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { buildSymbol, wrapSprite } from "./build-sprite";
import { PACKAGE, setIdentity, withSymbolSets } from "./symbol-sets";

/**
 * What a runtime symbol's drawing is a function of — the two Material Symbols
 * sets — so a runtime-symbols URL carrying it can be cached forever.
 */
export const symbolsHash: string = createHash("sha256")
  .update([PACKAGE.regular, PACKAGE.light].map(setIdentity).join("\n"))
  .digest("hex")
  .slice(0, 16);

// Per style key, every saved name's `<symbol>` — built in one pass the first
// time the style is asked for (the sets are parsed once for it and dropped),
// then kept: ~2 MB per style, and a picker scrolling through the whole set
// never parses again. A failed build is not cached.
const styles = new Map<StyleKey, Promise<ReadonlyMap<string, string>>>();

function styleSymbols(key: StyleKey): Promise<ReadonlyMap<string, string>> {
  let build = styles.get(key);
  if (!build) {
    build = withSymbolSets(
      (sets) =>
        new Map(
          allSavedSymbolNames().map((name) => [
            name,
            buildSymbol({
              id: runtimeSymbolId(key, name),
              ...resolveSymbol(sets, name, key),
            }),
          ]),
        ),
    ).catch((err: unknown) => {
      styles.delete(key);
      throw err;
    });
    styles.set(key, build);
  }
  return build;
}

/**
 * One `<svg>` of `<symbol id="msr-<key>-<name>">`s for `names` in style `key`,
 * each the style's own drawing or its nearest fallback (`resolveSymbol`).
 * Every name must be a saved symbol name (checked by the caller).
 */
export async function runtimeSymbols(
  key: StyleKey,
  names: readonly string[],
): Promise<string> {
  if (names.length === 0) return wrapSprite([]);
  const symbols = await styleSymbols(key);
  return wrapSprite(
    names.map((name) => {
      const symbol = symbols.get(name);
      if (symbol === undefined) {
        throw new Error(`[icons] "${name}" is not a saved symbol name`);
      }
      return symbol;
    }),
  );
}
