import { serveValue } from "@plugins/network/plugins/live/server";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import {
  DEFAULT_STYLE_KEYS,
  type SavedSymbolName,
} from "@plugins/ui/plugins/icons/core";
import {
  getSavedSpriteAsset,
  savedSymbolsHash,
  type SavedSpriteAsset,
} from "../../core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { runtimeSymbols, symbolsHash } from "./drawer";
import {
  savedIconSources,
  type SavedIconSource,
} from "@plugins/ui/plugins/icons/plugins/saved-sources/server";

/** Every saved name some saved-icon source holds right now, sorted, once each. */
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

/** The drawer's symbols hash: fixed for the host's life. */
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

/**
 * `GET /api/icons/saved-sprite-assets/:hash` — the default styles' drawing of
 * every saved name, for the shell's head to fetch at t0 (`head.ts`), so saved
 * icons are drawable at the first paint without riding the boot snapshot.
 * Revalidated, never stored stale: `no-cache` with an ETag over the names
 * (and the hash, which pins what each drawing is), so a page load whose names
 * did not move is a 304 before anything is drawn.
 */
export const handleSavedSpriteAsset = rawEndpointHandler(
  getSavedSpriteAsset,
  async (req, params) => {
    const hash = symbolsHash();
    if (params.hash !== hash) {
      return new Response(
        `Symbols version ${params.hash} is not this server's (${hash})`,
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    const names = await savedIconNames();
    const etag = `"${sha256Hex(`${hash}\n${names.join(",")}`).slice(0, 32)}"`;
    const headers = { "cache-control": "no-cache", etag };
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    const asset: SavedSpriteAsset = {
      names: [...names],
      sprites: Object.fromEntries(
        await Promise.all(
          DEFAULT_STYLE_KEYS.map(
            async (key) => [key, await runtimeSymbols(key, names)] as const,
          ),
        ),
      ),
    };
    return new Response(JSON.stringify(asset), {
      headers: { ...headers, "content-type": "application/json" },
    });
  },
);
