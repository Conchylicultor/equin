import {
  type FollowMap,
  followsAtBind,
} from "@plugins/network/plugins/live/core";
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
  type SavedIconSource,
} from "@plugins/ui/plugins/icons/plugins/saved-sources/server";

type Followed = Readonly<Record<string, readonly unknown[]>>;

/**
 * Every saved name some saved-icon source holds right now, sorted, once each.
 * A followed source's rows come from `followed` inside the sprites' loader
 * (the follow's own read), or are read through its collection's set
 * otherwise (a warm-up).
 */
export async function savedIconNames(
  followed?: Followed,
): Promise<readonly SavedSymbolName[]> {
  const names = new Set<SavedSymbolName>();
  for (const source of savedIconSources()) {
    for (const name of await namesOf(source, followed)) names.add(name);
  }
  return [...names].sort();
}

async function namesOf(
  source: SavedIconSource,
  followed: Followed | undefined,
): Promise<readonly SavedSymbolName[]> {
  switch (source.kind) {
    case "followed": {
      if (followed === undefined) {
        return source.namesOf(await source.collection.all.load(source.where));
      }
      const rows = followed[source.id];
      if (rows === undefined) {
        throw new Error(
          `[icons] the saved-icon source "${source.id}" was not followed — it registered after the sprites bound`,
        );
      }
      return source.namesOf(rows);
    }
    case "tables":
    case "watched":
      return source.names();
  }
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
 * The resident saved-icon sprites. DB-backed: each followed source's scope is
 * a follow (a write reaches the value only when it touches a row of that
 * scope and a column its collection reads), each whole-table source's tables
 * are reads (both built at the bind — sources register at module eval, after
 * this value is declared); a config source
 * bumps the tick while the value has a subscriber. The first subscriber also
 * bumps it once — a value restored from the persisted snapshot is recomputed
 * against config that changed while the backend was down.
 */
export const savedIconSpritesServed = serveValue(savedIconSprites, {
  source: "db",
  // Its loader runs every source's `names()`, reached through the registry.
  code: [import.meta, savedIconSourcesCode],
  // One follow per followed source, by its id — built at the bind, once
  // every source has registered.
  follows: followsAtBind<unknown, FollowMap>((follow) =>
    Object.fromEntries(
      savedIconSources().flatMap((s) =>
        s.kind === "followed"
          ? [[s.id, follow(s.collection, () => ({ where: s.where }))]]
          : [],
      ),
    ),
  ),
  reads: () => ({
    tables: [
      ...new Set(
        savedIconSources().flatMap((s) =>
          s.kind === "tables" ? s.tables : [],
        ),
      ),
    ],
    reason:
      "one resident value draws every name a whole-table saved-icon source holds, so a write to any row of its table may change it",
  }),
  recomputeOn: [savedIconsChangedServed],
  loader: async (_params, { followed }) => {
    const sorted = await savedIconNames(followed as Followed);
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
      s.kind === "watched" ? [s.watch(bump)] : [],
    );
    bump();
    return () => {
      for (const stop of stops) stop();
    };
  },
});
