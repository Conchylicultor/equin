import { serveValue } from "@plugins/network/plugins/live/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { savedSymbolsHash } from "../../core";
import { symbolsHash } from "./drawer";
import {
  savedIconSources,
  type SavedIconSource,
} from "@plugins/ui/plugins/icons/plugins/saved-sources/server";

/**
 * Every saved name some saved-icon source holds right now, sorted, once each —
 * what a browser host's drawer warms its stored drawings with
 * (`plugins/bundled-symbols`). The page never preloads them: a page loads the
 * saved icons it draws, glyph by glyph, like any other.
 */
export async function savedIconNames(): Promise<readonly SavedSymbolName[]> {
  const names = new Set<SavedSymbolName>();
  for (const source of savedIconSources()) {
    for (const name of await namesOf(source)) names.add(name);
  }
  return [...names].sort();
}

async function namesOf(
  source: SavedIconSource,
): Promise<readonly SavedSymbolName[]> {
  switch (source.kind) {
    case "followed":
      return source.namesOf(await source.collection.all.load(source.where));
    case "tables":
    case "watched":
      return source.names();
  }
}

/** The Material glyphs' hash: fixed for the host's life. */
export const savedSymbolsHashServed = serveValue(savedSymbolsHash, {
  source: "external",
  readCost: "memory",
  changes: {
    fixed: {
      reason:
        "a pure function of the drawer's sets, the savable-name list and the symbol build",
    },
  },
  loader: () => Promise.resolve(symbolsHash()),
});
