import { useEffect, useLayoutEffect, useState } from "react";
import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  isSpriteKey,
  isStyleKey,
  type SpriteKey,
  type StyleKey,
} from "@plugins/ui/plugins/icons/core";
import {
  IconSpriteSheet,
  hasSprite,
  installRuntimeSymbolLoader,
  provideRuntimeSymbols,
  provideSprite,
  useWantedSprites,
  useWantedStyleKeys,
} from "@plugins/ui/plugins/icons/web";
import {
  residentSprites,
  runtimeSymbolsEndpoint,
  savedIconSprites,
  spriteEndpoint,
  type IconSprites,
  type SavedIconSprites,
} from "../../core";
import { createRuntimeSymbolLoader } from "./runtime-symbol-loader";

// The page's icon sprites: page chrome, always loaded from the page's own server.
const fetchEndpoint = fetchEndpointOver(pageTransport);

function spriteKey(key: string): SpriteKey {
  if (isSpriteKey(key)) return key;
  throw new Error(`[icons] the server sent an unknown sprite key "${key}"`);
}

// Sprites being fetched, page-wide: a re-render never starts a second request
// for the same key.
const inflight = new Set<SpriteKey>();

async function fetchSprite(key: SpriteKey, hash: string): Promise<string> {
  const answer = await fetchEndpoint(
    spriteEndpoint,
    { hash, key },
    // Idempotent and content-addressed: a retry cannot land twice.
    { retry: { retries: 3, backoffMs: 300 } },
  );
  // Only reached once the resident sprites loaded, which they only do with the
  // computer behind the page — so this is a broken assumption, said.
  if (answer.kind === "unavailable") throw new Error(answer.message);
  return await answer.value.text();
}

/**
 * Keeps the page's sprites and renders the sheet. The resident ones arrive
 * with the boot snapshot; until they do (never, normally — they are
 * preloaded) the sheet is empty.
 */
export function IconSpriteHost() {
  const resident = useLive(residentSprites);
  const saved = useLive(savedIconSprites);
  // A failed read renders the empty sheet too (icons draw as empty boxes);
  // live-state's resource-error sink reports the failure. So does a page with
  // no computer behind it (`unavailable`): the sprites are built from the icon
  // sets installed on the computer, so it has none to draw.
  if (
    resident.status === "loading" ||
    resident.status === "error" ||
    resident.status === "unavailable"
  ) {
    return <IconSpriteSheet />;
  }
  if (
    saved.status === "loading" ||
    saved.status === "error" ||
    saved.status === "unavailable"
  ) {
    return <IconSpriteSheet />;
  }
  return <LoadedSprites resident={resident.data} saved={saved.data} />;
}

async function fetchRuntimeSymbols(
  hash: string,
  key: StyleKey,
  names: readonly string[],
): Promise<string> {
  const answer = await fetchEndpoint(
    runtimeSymbolsEndpoint,
    { hash, key },
    // Idempotent and content-addressed, like a sprite.
    {
      query: { names: names.join(",") },
      retry: { retries: 3, backoffMs: 300 },
    },
  );
  // Only reached once the saved sprites loaded (the computer is behind the
  // page) — a broken assumption if not, said.
  if (answer.kind === "unavailable") throw new Error(answer.message);
  return await answer.value.text();
}

/**
 * Holds the resident saved-icon symbols and installs the runtime-symbol loader:
 * every name `<Icon>` wants in a style no chunk holds is batched (one fetch per
 * style key per frame) and appended to the sheet. A failed batch is thrown into
 * this contribution's error boundary, like a failed sprite.
 */
function useSavedSymbols(saved: SavedIconSprites, fail: (err: Error) => void) {
  useLayoutEffect(() => {
    for (const [key, markup] of Object.entries(saved.sprites)) {
      const styleKey = spriteKey(key);
      // Saved icons are Material names: only a Material style key holds them.
      if (!isStyleKey(styleKey)) {
        throw new Error(
          `[icons] the saved-icon sprites hold no "${styleKey}" sprite`,
        );
      }
      provideRuntimeSymbols(
        `saved-${styleKey}`,
        markup,
        saved.names.map((name) => ({ styleKey, name })),
      );
    }
  }, [saved]);

  const { symbolsHash } = saved;
  useEffect(() => {
    const loader = createRuntimeSymbolLoader({
      fetchSymbols: (key, names) =>
        fetchRuntimeSymbols(symbolsHash, key, names),
      schedule: (flush) => void requestAnimationFrame(flush),
      onLoaded: provideRuntimeSymbols,
      onError: fail,
    });
    return installRuntimeSymbolLoader(loader.request);
  }, [symbolsHash, fail]);
}

/**
 * Provides the resident sprites and fetches, on demand, the sprite of every
 * style some theme scope wants that is not resident — and every sprite some
 * mounted icon asked for (the Seti file-type glyphs and a Lucide scope's
 * glyphs, never resident).
 *
 * A failed fetch is thrown from render, into this contribution's error
 * boundary, rather than leaving that style's icons on the default glyphs with
 * no word said.
 */
function LoadedSprites({
  resident,
  saved,
}: {
  resident: IconSprites;
  saved: SavedIconSprites;
}) {
  const wantedStyles = useWantedStyleKeys();
  const wantedSprites = useWantedSprites();
  const [failure, setFailure] = useState<Error | null>(null);
  useSavedSymbols(saved, setFailure);
  if (failure) throw failure;

  // A layout effect: the store update re-renders the sheet (and every icon
  // waiting on a sprite) before the browser paints.
  useLayoutEffect(() => {
    for (const [key, markup] of Object.entries(resident.sprites)) {
      provideSprite(spriteKey(key), markup);
    }
  }, [resident]);

  const { manifestHash } = resident;
  useEffect(() => {
    for (const key of [...wantedStyles, ...wantedSprites]) {
      if (hasSprite(key) || inflight.has(key)) continue;
      inflight.add(key);
      void fetchSprite(key, manifestHash).then(
        (markup) => {
          inflight.delete(key);
          provideSprite(key, markup);
        },
        (err: unknown) => {
          inflight.delete(key);
          setFailure(err instanceof Error ? err : new Error(String(err)));
        },
      );
    }
  }, [wantedStyles, wantedSprites, manifestHash]);

  return <IconSpriteSheet />;
}
