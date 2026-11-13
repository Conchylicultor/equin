import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import type { SpriteKey } from "@plugins/ui/plugins/icons/core";
import {
  createScopedRuntimeSymbols,
  IconSpriteSheet,
  pageRuntimeSymbols,
  provideSprite,
  RuntimeSymbolScope,
  RuntimeSymbolSheet,
  useWantedScopeSprites,
  useWantedSprites,
  useWantedStyleKeys,
  type RuntimeSymbolStore,
} from "@plugins/ui/plugins/icons/web";
import {
  iconSprite,
  RESIDENT_SPRITE_KEYS,
  runtimeSymbolsValue,
  savedSymbolsHash,
  spriteHash,
} from "../../core";
import { headProvidedResident } from "./boot";
import { createRuntimeSymbolLoader } from "./runtime-symbol-loader";
import { throwContractRefusal } from "./refusals";

/**
 * Keeps the page's sprites and renders the sheet. The resident sprites and the
 * saved-icon symbols the first paint needs were provided by the boot task, from
 * the requests the shell's head started (`boot.ts`); this reads, live, every
 * other sprite the page wants — and any resident one the head did not provide.
 * Until the sprite hash lands (it is preloaded, so never, normally) the sheet
 * draws what it holds.
 */
export function IconSpriteHost() {
  const hash = useLive(spriteHash);
  const symbols = useLive(savedSymbolsHash);
  // A failed read (live-state's resource-error sink reports it) leaves the
  // sheet with what the boot task provided.
  return (
    <>
      {hash.status === "ready" && <LoadedSprites hash={hash.data} />}
      {symbols.status === "ready" && (
        <SavedSymbols hash={symbols.data} store={pageRuntimeSymbols} />
      )}
      <IconSpriteSheet />
    </>
  );
}

/**
 * Installs `store`'s runtime-symbol loader: every name `<Icon>` wants in a
 * style no chunk holds is batched (one batch per style key per frame), read as
 * one `icons.runtime-symbols` tuple per batch while it is in flight — from the
 * server of the subtree this renders in — and handed to the store. A
 * contract-refused batch is thrown into the caller's error boundary; any other
 * failure is reported by live-state's resource-error sink and leaves that
 * batch's icons on their fallback, like a failed sprite; a `stale-symbols`
 * refusal waits for the new hash (`refusals.ts`).
 */
function SavedSymbols({
  hash,
  store,
}: {
  hash: string;
  store: RuntimeSymbolStore;
}) {
  const [loader] = useState(() =>
    createRuntimeSymbolLoader((flush) => void requestAnimationFrame(flush)),
  );
  useEffect(() => store.installLoader(loader.request), [loader, store]);

  // In memory: a server render reads the batches asked for so far (none).
  const batches = useSyncExternalStore(
    loader.subscribe,
    loader.batches,
    loader.batches,
  );
  const reads = useLive(
    runtimeSymbolsValue,
    batches.map((b) => ({ hash, key: b.styleKey, names: b.names.join(",") })),
  );
  // One result per batch, in order.
  const landed = batches.map((batch, i) => ({ batch, read: reads[i] }));
  // A contract refusal (an unknown style or name, unsorted names) is thrown;
  // a symbols hash the server moved past re-keys once the new hash is pushed
  // (`refusals.ts`).
  for (const { read } of landed) throwContractRefusal(read);
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
  return null;
}

/**
 * Reads, on demand, every sprite the page wants that the head did not provide
 * under `hash`: the resident ones it did not (no head, a head written by an
 * earlier backend, a failed request — `boot.ts`), the sprite of every style
 * some theme scope wants, and every sprite some mounted icon asked for (the
 * Seti file-type glyphs and a Lucide scope's glyphs, never resident) — as one
 * live read per key (`icons.sprite`).
 *
 * A contract refusal is thrown from render, into this contribution's error
 * boundary (a `stale-manifest` one waits for the new hash — `refusals.ts`);
 * a transient failure is reported and leaves that key unprovided
 * (its icons draw their fallback), so a blip never takes the sheet down.
 */
function LoadedSprites({ hash }: { hash: string }) {
  const wantedStyles = useWantedStyleKeys();
  const wantedSprites = useWantedSprites();

  // Every wanted key the head did not provide under this hash, once each. A
  // key stays read while it is wanted; the sheet keeps a sprite once provided.
  const onDemand = useMemo(() => {
    const head = headProvidedResident();
    return [
      ...new Set([...RESIDENT_SPRITE_KEYS, ...wantedStyles, ...wantedSprites]),
    ].filter((key) => head.hash !== hash || !head.keys.has(key));
  }, [wantedStyles, wantedSprites, hash]);
  const reads = useLive(
    iconSprite,
    onDemand.map((key) => ({ hash, key })),
  );
  // One result per key, in order.
  const sprites = onDemand.map((key, i) => ({ key, read: reads[i] }));
  // A contract refusal (an unknown key) is thrown, into this contribution's
  // error boundary. A manifest the server moved past (it restarted on another
  // build) is not one: the hash is pushed again and these reads re-key off it,
  // the sheet keeping the sprites it holds meanwhile (`refusals.ts`). Any other
  // failure leaves that key's icons on their fallback glyphs and is reported
  // by live-state's resource-error sink; the sheet stays up.
  for (const { read } of sprites) throwContractRefusal(read);
  useLayoutEffect(() => {
    for (const { key, read } of sprites) {
      if (read?.status === "ready") provideSprite(key, read.data);
    }
  });
  return null;
}

/**
 * Gives a plugin scope icons of its own: a runtime-symbol store bound to the
 * scope (`RuntimeSymbolScope`), filled from the server the scope reads — its
 * `icons.symbols-hash` and every `icons.runtime-symbols` batch its
 * icons want — and drawn in a sheet of its own inside the scope; and every
 * never-resident sprite its icons want (the Seti file-type glyphs, a Lucide
 * scope's) read as `icons.sprite` from that server too
 * ({@link ScopeSprites}). Mount it INSIDE the scope's `<PluginScope>` and
 * transport (`DemoScope` does): a saved icon in a scope with no store of its
 * own throws, it never reaches the page's store and so the page's server.
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
      <ScopeSprites store={store} />
      {children}
    </RuntimeSymbolScope>
  );
}

/**
 * The scope's runtime-symbol loader, once its server answered the symbols
 * hash. Until then (or on a failed read, which live-state's resource-error
 * sink reports) its saved icons are empty boxes at their final size, as the
 * page's are before their symbols load.
 */
function ScopeSavedSymbols({ store }: { store: RuntimeSymbolStore }) {
  const hash = useLive(savedSymbolsHash);
  return (
    <>
      {hash.status === "ready" && (
        <SavedSymbols hash={hash.data} store={store} />
      )}
      <RuntimeSymbolSheet store={store} />
    </>
  );
}

/**
 * The sprites a scope's icons asked for, read from the scope's server
 * (`icons.sprite`, under the hash that server serves) and provided to the
 * document's sheet — the same ids the page's sprites draw under, so a sprite
 * either side loaded draws for both. Until the hash or a sprite lands its
 * icons draw their fallback (a Seti icon an empty box at its final size), as
 * on the page; a contract refusal is thrown into the caller's error boundary
 * (a `stale-manifest` one waits for the scope's new hash — `refusals.ts`).
 */
function ScopeSprites({ store }: { store: RuntimeSymbolStore }) {
  const wanted = useWantedScopeSprites(store);
  // Nothing asked for yet: nothing read (a scope that shows no file pays nothing).
  if (wanted.length === 0) return null;
  return <ScopeSpriteHash wanted={wanted} />;
}

function ScopeSpriteHash({ wanted }: { wanted: readonly SpriteKey[] }) {
  const hash = useLive(spriteHash);
  switch (hash.status) {
    // Until it lands, or on a failed read (reported by live-state's
    // resource-error sink), the scope's icons draw their fallback.
    case "loading":
    case "error":
      return null;
    case "ready":
      return <ScopeSpriteReads hash={hash.data} wanted={wanted} />;
  }
}

function ScopeSpriteReads({
  hash,
  wanted,
}: {
  hash: string;
  wanted: readonly SpriteKey[];
}) {
  const reads = useLive(
    iconSprite,
    wanted.map((key) => ({ hash, key })),
  );
  const sprites = wanted.map((key, i) => ({ key, read: reads[i] }));
  for (const { read } of sprites) throwContractRefusal(read);
  useLayoutEffect(() => {
    for (const { key, read } of sprites) {
      if (read?.status === "ready") provideSprite(key, read.data);
    }
  });
  return null;
}
