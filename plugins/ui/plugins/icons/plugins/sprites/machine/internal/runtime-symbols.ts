import type { SavedSymbolName, StyleKey } from "@plugins/ui/plugins/icons/core";
import { allSavedSymbolNames } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { drawRuntimeSymbol, type RuntimeSymbolDrawerImpl } from "../../server";
import { PACKAGE, setIdentity, withSymbolSets } from "./symbol-sets";

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
            drawRuntimeSymbol(sets, key, name),
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
 * The desktop's drawer: both Material Symbols sets installed on the computer
 * (`icon-sets.js`, embedded in the build), every style key of every saved
 * name.
 */
export const installedSetsDrawer: RuntimeSymbolDrawerImpl = {
  identity: [PACKAGE.regular, PACKAGE.light].map(setIdentity).join("\n"),
  async draw(key: StyleKey, names: readonly SavedSymbolName[]) {
    const symbols = await styleSymbols(key);
    return names.map((name) => {
      const symbol = symbols.get(name);
      if (symbol === undefined) {
        throw new Error(`[icons] "${name}" is not a saved symbol name`);
      }
      return symbol;
    });
  },
};
