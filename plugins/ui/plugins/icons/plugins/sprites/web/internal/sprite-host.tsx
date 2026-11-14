import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  isStyleKey,
  type GlyphKey,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import {
  createScopedRuntimeSymbols,
  IconSpriteSheet,
  pageRuntimeSymbols,
  provideSprite,
  RuntimeSymbolScope,
  RuntimeSymbolSheet,
  useWantedScopeSprites,
  useWantedSprites,
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
import {
  createRuntimeSymbolLoader,
  type RuntimeSymbolLoader,
} from "./runtime-symbol-loader";
import { throwContractRefusal } from "./refusals";
import { useFirstFrameGate, type GlyphHashes } from "./first-frame";

function hashOf(hashes: GlyphHashes, key: GlyphKey): string {
  return isStyleKey(key) ? hashes.material : hashes.sprite;
}

/**
 * A loader flushing once the current commit is done: every `<Icon>` asks in a
 * layout effect, so one commit's wants are one batch per key. Not a frame
 * callback — a tab loaded in the background runs none, and its first frame
 * would wait for nothing.
 */
function newLoader(): RuntimeSymbolLoader {
  return createRuntimeSymbolLoader((flush) => queueMicrotask(flush));
}

/**
 * Keeps the page's icons and renders the sheet. The brands and the glyph
 * batches the page's last first frame drew were provided by the boot task,
 * from the requests the shell's head started (`boot.ts`); this installs the
 * page's glyph loader — every glyph an `<Icon>` wants that no chunk holds,
 * read live in per-frame batches — reads the whole sprites the page wants
 * (the brands when the head did not provide them, Seti once a file icon
 * mounts), and holds the first paint until the first frame's glyphs are in
 * (`first-frame.ts`). Until the hashes land (they are preloaded, so never,
 * normally) the sheet draws what it holds.
 */
export function IconSpriteHost() {
  const [loader] = useState(newLoader);
  const sprite = useLive(spriteHash);
  const material = useLive(savedSymbolsHash);
  const hashes =
    sprite.status === "ready" && material.status === "ready"
      ? { material: material.data, sprite: sprite.data }
      : null;
  // The gate reads the hashes when the first frame settles — after this render.
  const latest = useLatestRef(hashes);
  // Without its hashes the page can ask for no glyph: the first frame shows.
  useFirstFrameGate(
    loader,
    latest,
    sprite.status === "error" || material.status === "error",
  );
  // A failed read (live-state's resource-error sink reports it) leaves the
  // sheet with what the boot task provided.
  return (
    <>
      {sprite.status === "ready" && <LoadedSprites hash={sprite.data} />}
      {sprite.status === "ready" && material.status === "ready" && (
        <Glyphs
          hashes={{ material: material.data, sprite: sprite.data }}
          store={pageRuntimeSymbols}
          loader={loader}
        />
      )}
      <IconSpriteSheet />
    </>
  );
}

/**
 * Installs `loader` on `store`: every glyph `<Icon>` wants that no chunk
 * holds is batched (one batch per glyph key per frame), read as one
 * `icons.runtime-symbols` tuple per batch while it is in flight — from the
 * server of the subtree this renders in — and handed to the store. A
 * contract-refused batch is thrown into the caller's error boundary; any other
 * failure is reported by live-state's resource-error sink and leaves that
 * batch's icons on their fallback; a `stale-symbols` refusal waits for the new
 * hash (`refusals.ts`).
 */
function Glyphs({
  hashes,
  store,
  loader,
}: {
  hashes: GlyphHashes;
  store: RuntimeSymbolStore;
  loader: RuntimeSymbolLoader;
}) {
  useEffect(() => store.installLoader(loader.request), [loader, store]);

  // In memory: a server render reads the batches asked for so far (none).
  const batches = useSyncExternalStore(
    loader.subscribe,
    loader.batches,
    loader.batches,
  );
  const reads = useLive(
    runtimeSymbolsValue,
    batches.map((b) => ({
      hash: hashOf(hashes, b.key),
      key: b.key,
      names: b.names.join(","),
    })),
  );
  // One result per batch, in order.
  const landed = batches.map((batch, i) => ({ batch, read: reads[i] }));
  // A contract refusal (an unknown key, unsorted names) is thrown; a hash the
  // server moved past re-keys once the new hash is pushed (`refusals.ts`).
  for (const { read } of landed) throwContractRefusal(read);
  useLayoutEffect(() => {
    for (const { batch, read } of landed) {
      if (read?.status === "error") {
        // Reported by live-state's resource-error sink, and retried by it on
        // the next online / visible event; meanwhile its glyphs are no
        // longer awaited (the first frame shows without them).
        store.settleFailed(
          batch.names.map((name) => ({ key: batch.key, name })),
        );
        continue;
      }
      if (read?.status !== "ready") continue;
      store.provide(
        batch.chunkId,
        read.data,
        batch.names.map((name) => ({ key: batch.key, name })),
      );
      // The sheet keeps the chunk: the tuple need not stay read.
      loader.landed(batch.chunkId);
    }
  });
  return null;
}

/**
 * Reads, on demand, every whole sprite the page wants that the head did not
 * provide under `hash`: the resident brands when it did not (no head, a head
 * written by an earlier backend, a failed request — `boot.ts`), and every
 * sprite some mounted icon asked for (the Seti file-type glyphs) — as one live
 * read per key (`icons.sprite`).
 *
 * A contract refusal is thrown from render, into this contribution's error
 * boundary (a `stale-manifest` one waits for the new hash — `refusals.ts`);
 * a transient failure is reported and leaves that key unprovided
 * (its icons draw their fallback), so a blip never takes the sheet down.
 */
function LoadedSprites({ hash }: { hash: string }) {
  const wantedSprites = useWantedSprites();

  // Every wanted key the head did not provide under this hash, once each. A
  // key stays read while it is wanted; the sheet keeps a sprite once provided.
  const onDemand = useMemo(() => {
    const head = headProvidedResident();
    return [...new Set([...RESIDENT_SPRITE_KEYS, ...wantedSprites])].filter(
      (key) => head.hash !== hash || !head.keys.has(key),
    );
  }, [wantedSprites, hash]);
  return <SpriteReads hash={hash} keys={onDemand} />;
}

/**
 * One live read per sprite key (`icons.sprite`) under `hash`, each provided to
 * the document's sheet as it lands. A contract refusal (an unknown key) is
 * thrown, into the caller's error boundary. A manifest the server moved past
 * (it restarted on another build) is not one: the hash is pushed again and
 * these reads re-key off it, the sheet keeping the sprites it holds meanwhile
 * (`refusals.ts`). Any other failure leaves that key's icons on their
 * fallback glyphs and is reported by live-state's resource-error sink.
 */
function SpriteReads({
  hash,
  keys,
}: {
  hash: string;
  keys: readonly SpriteKey[];
}) {
  const reads = useLive(
    iconSprite,
    keys.map((key) => ({ hash, key })),
  );
  // One result per key, in order.
  const sprites = keys.map((key, i) => ({ key, read: reads[i] }));
  for (const { read } of sprites) throwContractRefusal(read);
  useLayoutEffect(() => {
    for (const { key, read } of sprites) {
      if (read?.status === "ready") provideSprite(key, read.data);
    }
  });
  return null;
}

/**
 * Gives a plugin scope icons of its own: a glyph store bound to the scope
 * (`RuntimeSymbolScope`), filled from the server the scope reads — its hashes
 * and every `icons.runtime-symbols` batch its saved icons and Lucide glyphs
 * want — and drawn in a sheet of its own inside the scope; and every whole
 * sprite its icons want (the Seti file-type glyphs) read as `icons.sprite`
 * from that server too ({@link ScopeSprites}). Mount it INSIDE the scope's
 * `<PluginScope>` and transport (`DemoScope` does): a saved icon in a scope
 * with no store of its own throws, it never reaches the page's store and so
 * the page's server. (Its code Material symbols are the page's: the same
 * drawing, and a browser host's drawer would load its whole bundled set.)
 */
export function ScopeIconSymbols({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [store] = useState(createScopedRuntimeSymbols);
  return (
    <RuntimeSymbolScope store={store}>
      <ScopeGlyphs store={store} />
      <ScopeSprites store={store} />
      {children}
    </RuntimeSymbolScope>
  );
}

/**
 * The scope's glyph loader, once its server answered both hashes. Until then
 * (or on a failed read, which live-state's resource-error sink reports) its
 * saved icons are empty boxes at their final size, as the page's are before
 * their glyphs load.
 */
function ScopeGlyphs({ store }: { store: RuntimeSymbolStore }) {
  const [loader] = useState(newLoader);
  const sprite = useLive(spriteHash);
  const material = useLive(savedSymbolsHash);
  return (
    <>
      {sprite.status === "ready" && material.status === "ready" && (
        <Glyphs
          hashes={{ material: material.data, sprite: sprite.data }}
          store={store}
          loader={loader}
        />
      )}
      <RuntimeSymbolSheet store={store} />
    </>
  );
}

/**
 * The whole sprites a scope's icons asked for, read from the scope's server
 * (`icons.sprite`, under the hash that server serves) and provided to the
 * document's sheet — the same ids the page's sprites draw under, so a sprite
 * either side loaded draws for both. Until the hash or a sprite lands its
 * icons draw their fallback (a Seti icon an empty box at its final size), as
 * on the page.
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
      return <SpriteReads hash={hash.data} keys={wanted} />;
  }
}
