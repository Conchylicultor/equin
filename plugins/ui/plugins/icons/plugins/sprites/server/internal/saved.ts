import { serveValue } from "@plugins/network/plugins/live/server";
import { DEFAULT_STYLE_KEYS } from "@plugins/ui/plugins/icons/core";
import { savedIconSprites, savedIconsChanged } from "../../core";
import { runtimeSymbols, symbolsHash } from "./runtime-symbols";
import { savedIconSources } from "./saved-sources";

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
  reads: () => ({
    tables: [...new Set(savedIconSources().flatMap((s) => s.tables))],
    reason:
      "one resident value draws every name any saved-icon source holds, so a write to any row of a source's table may change it",
  }),
  recomputeOn: [savedIconsChangedServed],
  loader: async () => {
    const names = new Set<string>();
    for (const source of savedIconSources()) {
      for (const name of await source.names()) names.add(name);
    }
    const sorted = [...names].sort();
    return {
      symbolsHash,
      names: sorted,
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
