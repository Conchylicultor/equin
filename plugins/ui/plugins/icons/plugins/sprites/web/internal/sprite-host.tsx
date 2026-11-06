import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  isSpriteKey,
  isStyleKey,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import {
  createScopedRuntimeSymbols,
  IconSpriteSheet,
  pageRuntimeSymbols,
  provideSprite,
  RuntimeSymbolScope,
  RuntimeSymbolSheet,
  useWantedSprites,
  useWantedStyleKeys,
  type RuntimeSymbolStore,
} from "@plugins/ui/plugins/icons/web";
import {
  iconSprite,
  residentSprites,
  runtimeSymbolsValue,
  savedIconSprites,
  type IconSprites,
  type SavedIconSprites,
} from "../../core";
import { createRuntimeSymbolLoader } from "./runtime-symbol-loader";

function spriteKey(key: string): SpriteKey {
  if (isSpriteKey(key)) return key;
  throw new Error(`[icons] the server sent an unknown sprite key "${key}"`);
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
  // no computer behind it (`unavailable`): the manifest's sprites are built
  // from the icon sets installed on the computer, so it has none to draw.
  if (
    resident.status === "loading" ||
    resident.status === "error" ||
    resident.status === "unavailable"
  ) {
    return <IconSpriteSheet />;
  }
  if (saved.status === "loading" || saved.status === "error") {
    return <IconSpriteSheet />;
  }
  return <LoadedSprites resident={resident.data} saved={saved.data} />;
}

/**
 * Holds the resident saved-icon symbols in `store` and installs its
 * runtime-symbol loader: every name `<Icon>` wants in a style no chunk holds
 * is batched (one batch per style key per frame), read as one
 * `icons.runtime-symbols` tuple per batch while it is in flight — from the
 * server of the subtree this renders in — and handed to the store. A refused
 * batch is thrown into the caller's error boundary; any other failure is
 * reported by live-state's resource-error sink and leaves that batch's icons
 * on their fallback, like a failed sprite.
 */
function useSavedSymbols(saved: SavedIconSprites, store: RuntimeSymbolStore) {
  useLayoutEffect(() => {
    for (const [key, markup] of Object.entries(saved.sprites)) {
      const styleKey = spriteKey(key);
      // Saved icons are Material names: only a Material style key holds them.
      if (!isStyleKey(styleKey)) {
        throw new Error(
          `[icons] the saved-icon sprites hold no "${styleKey}" sprite`,
        );
      }
      store.provide(
        `saved-${styleKey}`,
        markup,
        saved.names.map((name) => ({ styleKey, name })),
      );
    }
  }, [saved, store]);

  const [loader] = useState(() =>
    createRuntimeSymbolLoader((flush) => void requestAnimationFrame(flush)),
  );
  useEffect(() => store.installLoader(loader.request), [loader, store]);

  const batches = useSyncExternalStore(loader.subscribe, loader.batches);
  const reads = useLive(
    runtimeSymbolsValue,
    batches.map((b) => ({
      hash: saved.symbolsHash,
      key: b.styleKey,
      names: b.names.join(","),
    })),
  );
  // One result per batch, in order.
  const landed = batches.map((batch, i) => ({ batch, read: reads[i] }));
  for (const { read } of landed) {
    // A refusal (an unknown style or name, unsorted names, a sets hash this
    // server does not serve) is a contract fault no retry fixes.
    if (read?.status === "error" && read.error.kind === "refused")
      throw read.error;
  }
  useLayoutEffect(() => {
    for (const { batch, read } of landed) {
      if (read?.status !== "ready") continue;
      store.provide(
        batch.chunkId,
        read.data,
        batch.names.map((name) => ({ styleKey: batch.styleKey, name })),
      );
      // The sheet keeps the chunk: the tuple need not stay read.
      loader.landed(batch.chunkId);
    }
  });
}

/**
 * Provides the resident sprites and reads, on demand, the sprite of every
 * style some theme scope wants that is not resident — and every sprite some
 * mounted icon asked for (the Seti file-type glyphs and a Lucide scope's
 * glyphs, never resident) — as one live read per key (`icons.sprite`).
 *
 * A refused read is thrown from render, into this contribution's error
 * boundary; a transient failure is reported and leaves that key unprovided
 * (its icons draw their fallback), so a blip never takes the sheet down.
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
  useSavedSymbols(saved, pageRuntimeSymbols);

  // A layout effect: the store update re-renders the sheet (and every icon
  // waiting on a sprite) before the browser paints.
  useLayoutEffect(() => {
    for (const [key, markup] of Object.entries(resident.sprites)) {
      provideSprite(spriteKey(key), markup);
    }
  }, [resident]);

  // Every wanted key the resident value does not carry, once each. A key
  // stays read while it is wanted; the sheet keeps a sprite once provided.
  const onDemand = useMemo(
    () =>
      [...new Set([...wantedStyles, ...wantedSprites])].filter(
        (key) => !Object.hasOwn(resident.sprites, key),
      ),
    [wantedStyles, wantedSprites, resident],
  );
  const reads = useLive(
    iconSprite,
    onDemand.map((key) => ({ hash: resident.manifestHash, key })),
  );
  // Only reached once the resident sprites loaded, which they only do with the
  // computer behind the page — so this is a broken assumption, said.
  if ("status" in reads) throw new Error(reads.message);
  // One result per key, in order.
  const sprites = onDemand.map((key, i) => ({ key, read: reads[i] }));
  for (const { read } of sprites) {
    // A refusal (an unknown key, a manifest this server does not serve) is a
    // contract fault no retry fixes: thrown, into this contribution's error
    // boundary. Any other failure leaves that key's icons on their fallback
    // glyphs — as a failed resident read leaves the sheet empty — and is
    // reported by live-state's resource-error sink; the sheet stays up.
    if (read?.status === "error" && read.error.kind === "refused")
      throw read.error;
  }
  useLayoutEffect(() => {
    for (const { key, read } of sprites) {
      if (read?.status === "ready") provideSprite(key, read.data);
    }
  });

  return <IconSpriteSheet />;
}

/**
 * Gives a plugin scope saved icons of its own: a runtime-symbol store bound to
 * the scope (`RuntimeSymbolScope`), filled from the server the scope reads —
 * its resident `icons.saved-sprites` and every `icons.runtime-symbols` batch
 * its icons want — and drawn in a sheet of its own inside the scope. Mount it
 * INSIDE the scope's `<PluginScope>` and transport (`DemoScope` does): a saved
 * icon in a scope with no store of its own throws, it never reaches the
 * page's store and so the page's server.
 */
export function ScopeIconSymbols({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [store] = useState(createScopedRuntimeSymbols);
  return (
    <RuntimeSymbolScope store={store}>
      <ScopeSavedSymbols store={store} />
      {children}
    </RuntimeSymbolScope>
  );
}

/**
 * The scope's resident saved symbols and loader, once its server answered
 * them. Until then (or on a failed read, which live-state's resource-error
 * sink reports) its saved icons are empty boxes at their final size, as the
 * page's are before its sheet loads.
 */
function ScopeSavedSymbols({ store }: { store: RuntimeSymbolStore }) {
  const saved = useLive(savedIconSprites);
  switch (saved.status) {
    case "loading":
    case "error":
      return <RuntimeSymbolSheet store={store} />;
    case "ready":
      return <LoadedScopeSymbols saved={saved.data} store={store} />;
  }
}

function LoadedScopeSymbols({
  saved,
  store,
}: {
  saved: SavedIconSprites;
  store: RuntimeSymbolStore;
}) {
  useSavedSymbols(saved, store);
  return <RuntimeSymbolSheet store={store} />;
}
