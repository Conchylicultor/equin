import { serveValue } from "@plugins/network/plugins/live/server";
import {
  DEFAULT_STYLE_KEYS,
  type SavedSymbolName,
} from "@plugins/ui/plugins/icons/core";
import { savedIconSprites, savedIconsChanged } from "../../core";
import { runtimeSymbols, symbolsHash } from "./drawer";
import {
  savedIconSources,
  savedIconSourcesCode,
} from "@plugins/ui/plugins/icons/plugins/saved-sources/server";

/** Every saved name some saved-icon source holds right now, sorted, once each. */
export async function savedIconNames(): Promise<readonly SavedSymbolName[]> {
  const names = new Set<SavedSymbolName>();
  for (const source of savedIconSources()) {
    for (const name of await source.names()) names.add(name);
  }
  return [...names].sort();
}

let changes = 0;

/** The tick non-DB sources bump; nothing but {@link savedIconSpritesServed} reads it. */
export const savedIconsChangedServed = serveValue(savedIconsChanged, {
  source: "external",
  changes: "notified",
  loader: () => changes,
});

function bump(): void {
  changes++;
  savedIconsChangedServed.notify();
}

/**
 * The resident saved-icon sprites. DB-backed: the tables every source declares
 * are the value's reads (a thunk — sources register at module eval, after this
 * value is declared), so a change to them recomputes the value; a config source
 * bumps the tick while the value has a subscriber. The first subscriber also
 * bumps it once — a value restored from the persisted snapshot is recomputed
 * against config that changed while the backend was down.
 */
export const savedIconSpritesServed = serveValue(savedIconSprites, {
  source: "db",
  // Its loader runs every source's `names()`, reached through the registry.
  code: [import.meta, savedIconSourcesCode],
  reads: () => ({
    tables: [...new Set(savedIconSources().flatMap((s) => s.tables))],
    reason:
      "one resident value draws every name any saved-icon source holds, so a write to any row of a source's table may change it",
  }),
  recomputeOn: [savedIconsChangedServed],
  loader: async () => {
    const sorted = await savedIconNames();
    return {
      symbolsHash: symbolsHash(),
      names: [...sorted],
      sprites: Object.fromEntries(
        await Promise.all(
          DEFAULT_STYLE_KEYS.map(
            async (key) => [key, await runtimeSymbols(key, sorted)] as const,
          ),
        ),
      ),
    };
  },
  whileSubscribed: () => {
    const stops = savedIconSources().flatMap((s) =>
      s.watch ? [s.watch(bump)] : [],
    );
    bump();
    return () => {
      for (const stop of stops) stop();
    };
  },
});
