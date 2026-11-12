import type { SavedSymbolName, StyleKey } from "@plugins/ui/plugins/icons/core";
import { drawRuntimeSymbol, type RuntimeSymbolDrawerImpl } from "../../server";
import { PACKAGE, setIdentity, withSymbolSets } from "./symbol-sets";

// Per style key, the `<symbol>` of every name drawn so far. A draw asks only
// for the names it was given: the ones not drawn yet are drawn in one pass
// over the sets (parsed once for the pass and dropped — concurrent passes
// share one parse), then kept, so a name is drawn at most once per process.
//
// It used to draw EVERY saved name (4,240) the first time a style was asked
// for — what a boot paid in full, twice (the resident saved-icon sprites ask
// both default styles) to serve the handful of names anyone saved. Only a
// picker reaches the whole set, a batch at a time, and it now pays for the
// names it shows. A failed pass keeps nothing.
const drawn = new Map<StyleKey, Map<SavedSymbolName, Promise<string>>>();

function symbolsOf(
  key: StyleKey,
  names: readonly SavedSymbolName[],
): Promise<readonly string[]> {
  let style = drawn.get(key);
  if (style === undefined) {
    style = new Map();
    drawn.set(key, style);
  }
  const held = style;
  const missing = names.filter((name) => !held.has(name));
  if (missing.length > 0) {
    const pending = new Map<SavedSymbolName, Promise<string>>();
    const pass = withSymbolSets(
      (sets) =>
        new Map(
          missing.map((name) => [name, drawRuntimeSymbol(sets, key, name)]),
        ),
    ).catch((err: unknown) => {
      // Not kept: the next draw of these names parses again (and fails
      // loudly again); every caller awaiting them sees this rejection.
      for (const [name, symbol] of pending) {
        if (held.get(name) === symbol) held.delete(name);
      }
      throw err;
    });
    for (const name of missing) {
      const symbol = pass.then((symbols) => symbols.get(name)!);
      pending.set(name, symbol);
      held.set(name, symbol);
    }
  }
  return Promise.all(names.map((name) => held.get(name)!));
}

/**
 * The desktop's drawer: both Material Symbols sets installed on the computer
 * (`icon-sets.js`, embedded in the build), every style key of every saved
 * name.
 */
export const installedSetsDrawer: RuntimeSymbolDrawerImpl = {
  identity: [PACKAGE.regular, PACKAGE.light].map(setIdentity).join("\n"),
  draw(key: StyleKey, names: readonly SavedSymbolName[]) {
    return symbolsOf(key, names);
  },
};
