import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import { glyphId, type GlyphKey, type SpriteKey } from "../../core";
import { wantSprite as wantPageSprite } from "./sprite-store";

/**
 * The GLYPHS a server drew for the icons in one part of the page, loaded one
 * glyph at a time: every Material symbol in any style — code `symbol("…")`s
 * and saved (user-picked) names alike — and the Lucide family's drawings
 * (`GlyphKey`). A page holds the glyphs it drew, never a whole set. They
 * arrive in chunks — those the shell's head fetched at t0 (the page's memory
 * of its last first frame) and each on-demand batch — read from THAT part's
 * server by whoever installed the loader (the sprites plugin), so a demo's
 * saved icons come from the demo's server and the page's from the page's.
 *
 * `<Icon>` asks its store for (key, name); a glyph no chunk holds yet is a
 * WANT, handed to the store's loader. A glyph a chunk was asked for and does
 * not carry is MISSING: the server draws no such glyph (drawn as the
 * missing-glyph marker and reported, never an empty box). This plugin sits
 * below the network layer, so the loader is installed from above rather than
 * imported.
 */

/** One glyph: a name in a key. */
export interface GlyphEntry {
  readonly key: GlyphKey;
  readonly name: string;
}

type WantListener = (entry: GlyphEntry) => void;

export interface RuntimeSymbolStore {
  /** The `<symbol id>` this store's chunks draw (key, name) under. */
  symbolId(key: GlyphKey, name: string): string;
  hasSymbol(key: GlyphKey, name: string): boolean;
  /** A glyph a chunk was asked for and does not carry. */
  isMissing(key: GlyphKey, name: string): boolean;
  /** Ask the installed loader for `name` in `key` (a no-op once held, missing or asked). */
  want(key: GlyphKey, name: string): void;
  /**
   * Hold `markup` (a whole `<svg>` of `<symbol>`s, ids as `glyphId` spells
   * them) as chunk `chunkId`, replacing what that chunk held. `entries` are
   * the glyphs it was asked for; one it does not carry is missing. A no-op
   * when the chunk already holds these bytes.
   */
  provide(
    chunkId: string,
    markup: string,
    entries: readonly GlyphEntry[],
  ): void;
  /**
   * Install the loader every want is handed to. Wants made before it was
   * installed are replayed to it. One loader per store — a second throws.
   */
  installLoader(listener: WantListener): () => void;
  /** Subscribe to every chunk landing. */
  subscribe(listener: () => void): () => void;
  /** Every chunk's markup (ids as {@link symbolId} spells them), sorted by chunk id. */
  chunks(): readonly (readonly [string, string])[];
  /** How many glyphs are wanted and neither landed, known missing nor failed. */
  pendingCount(): number;
  /**
   * The read asking for `entries` failed (a transient error its reader may
   * still retry): they stop counting as pending — the first frame never waits
   * on a failure — and stay asked, so a later answer still lands.
   */
  settleFailed(entries: readonly GlyphEntry[]): void;
  /**
   * Ask for a never-resident whole SPRITE (the Seti glyphs) from this part's
   * server: the page's store hands it to the page's sprite host; a scope's
   * keeps it for the scope's own reader ({@link wantedSprites}), so a demo's
   * file icons are drawn by the demo's server.
   */
  wantSprite(key: SpriteKey): void;
  /** Every sprite asked for here, sorted (a scope's; the page's lives in the sprite store). */
  wantedSprites(): readonly SpriteKey[];
  /** Subscribe to a new sprite asked for here. */
  subscribeWantedSprites(listener: () => void): () => void;
}

function entryKey(key: GlyphKey, name: string): string {
  return `${key}\u0000${name}`;
}

/** The `<symbol id>`s a chunk carries — a regex over the server's own markup, so a static render answers the same. */
function symbolIdsIn(markup: string): ReadonlySet<string> {
  return new Set(
    [...markup.matchAll(/<symbol\b[^>]*?\sid="([^"]+)"/g)].map((m) => m[1]!),
  );
}

/**
 * Prefix every id of a chunk and every in-chunk reference to one (an active
 * form's masks: `url(#…)`, `href="#…"`), so a scope's sheet never repeats an
 * id of the page's. The markup is the server's own, built from the icon sets.
 */
function prefixIds(raw: string, idPrefix: string): string {
  return raw
    .replace(/(\s)id="/g, `$1id="${idPrefix}`)
    .replaceAll("url(#", `url(#${idPrefix}`)
    .replace(/(\s)href="#/g, `$1href="#${idPrefix}`);
}

/**
 * A store whose symbol ids carry `idPrefix` before the server's own, so two
 * stores' sheets in one document never hold one id twice. The page's store
 * has none.
 */
function createStore(
  idPrefix: string,
  ownSprites: boolean,
): RuntimeSymbolStore {
  const sprites = new Set<SpriteKey>();
  let spritesSnapshot: readonly SpriteKey[] = [];
  const spriteListeners = new Set<() => void>();
  const held = new Map<
    string,
    {
      markup: string;
      carried: readonly string[];
      absent: readonly string[];
    }
  >();
  let provided = new Set<string>();
  let missing = new Set<string>();
  let snapshot: readonly (readonly [string, string])[] = [];
  const listeners = new Set<() => void>();
  const pendingWants = new Map<string, GlyphEntry>();
  let loader: WantListener | null = null;
  return {
    symbolId: (key, name) => idPrefix + glyphId(key, name),
    hasSymbol: (key, name) => provided.has(entryKey(key, name)),
    isMissing: (key, name) => missing.has(entryKey(key, name)),
    want(key, name) {
      const k = entryKey(key, name);
      if (provided.has(k) || missing.has(k) || pendingWants.has(k)) return;
      const entry = { key, name };
      pendingWants.set(k, entry);
      loader?.(entry);
    },
    provide(chunkId, raw, entries) {
      const markup = idPrefix === "" ? raw : prefixIds(raw, idPrefix);
      if (held.get(chunkId)?.markup === markup) return;
      const ids = symbolIdsIn(raw);
      const carried: string[] = [];
      const absent: string[] = [];
      for (const e of entries) {
        (ids.has(glyphId(e.key, e.name)) ? carried : absent).push(
          entryKey(e.key, e.name),
        );
      }
      held.set(chunkId, { markup, carried, absent });
      provided = new Set([...held.values()].flatMap((c) => c.carried));
      missing = new Set(
        [...held.values()]
          .flatMap((c) => c.absent)
          .filter((k) => !provided.has(k)),
      );
      for (const k of [...pendingWants.keys()]) {
        if (provided.has(k) || missing.has(k)) pendingWants.delete(k);
      }
      snapshot = [...held.entries()]
        .map(([id, chunk]) => [id, chunk.markup] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      for (const l of listeners) l();
    },
    installLoader(listener) {
      if (loader !== null) {
        throw new Error("[icons] a glyph loader is already installed");
      }
      loader = listener;
      for (const entry of pendingWants.values()) listener(entry);
      return () => {
        if (loader === listener) loader = null;
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    chunks: () => snapshot,
    pendingCount: () => pendingWants.size,
    settleFailed(entries) {
      let changed = false;
      for (const e of entries) {
        changed = pendingWants.delete(entryKey(e.key, e.name)) || changed;
      }
      if (changed) for (const l of listeners) l();
    },
    wantSprite(key) {
      if (!ownSprites) {
        wantPageSprite(key);
        return;
      }
      if (sprites.has(key)) return;
      sprites.add(key);
      spritesSnapshot = [...sprites].sort();
      for (const l of spriteListeners) l();
    },
    wantedSprites: () => spritesSnapshot,
    subscribeWantedSprites(listener) {
      spriteListeners.add(listener);
      return () => spriteListeners.delete(listener);
    },
  };
}

/** The page's own store: every icon outside a plugin scope draws from it. */
export const pageRuntimeSymbols: RuntimeSymbolStore = createStore("", false);

let scopedStores = 0;

/** A store of its own, for a plugin scope's icons (see {@link RuntimeSymbolScope}). */
export function createScopedRuntimeSymbols(): RuntimeSymbolStore {
  scopedStores++;
  return createStore(`rs${scopedStores}-`, true);
}

const NO_CHUNKS: readonly (readonly [string, string])[] = [];
const NO_SPRITES: readonly SpriteKey[] = [];

/** Every sprite asked for in `store` (a scope's), re-read when one is. */
export function useWantedScopeSprites(
  store: RuntimeSymbolStore,
): readonly SpriteKey[] {
  // In memory: a server render reads what the store holds.
  return useSyncExternalStore(
    store.subscribeWantedSprites,
    store.wantedSprites,
    store.wantedSprites,
  );
}

/** Every chunk of `store`, re-read when one lands. */
export function useRuntimeSymbolChunks(
  store: RuntimeSymbolStore,
): readonly (readonly [string, string])[] {
  return useSyncExternalStore(store.subscribe, store.chunks, store.chunks);
}

/**
 * A store for a plugin scope that mounted none: every read of a saved icon
 * throws, naming the scope — it never falls through to the page's store, whose
 * loader reads the PAGE's server.
 */
function unsourced(scope: string): RuntimeSymbolStore {
  const refuse = (): never => {
    throw new Error(
      `[icons] a saved icon is drawn inside plugin scope "${scope}", which has no runtime-symbol store of its own: mount one inside the scope (ui/icons/sprites' ScopeIconSymbols), so its icons come from the scope's server`,
    );
  };
  return {
    symbolId: refuse,
    hasSymbol: refuse,
    isMissing: refuse,
    want: refuse,
    provide: refuse,
    installLoader: refuse,
    // Every <Icon> and markup reader subscribes and lists the chunks; only a
    // saved icon asks for a symbol, which is what refuses.
    subscribe: () => () => {},
    chunks: () => NO_CHUNKS,
    pendingCount: () => 0,
    settleFailed: refuse,
    // A build sprite in a scope with no store of its own is the page's, as
    // before scopes had stores: a scope that must not reach the page's server
    // mounts one (`ScopeIconSymbols`).
    wantSprite: wantPageSprite,
    wantedSprites: () => NO_SPRITES,
    subscribeWantedSprites: () => () => {},
  };
}

const RuntimeSymbolContext = createContext<{
  store: RuntimeSymbolStore;
  scope: string | null;
} | null>(null);

/**
 * Every saved icon below draws from `store` — mounted inside a
 * `<PluginScope>` by the code that gives the scope its server (the sprites
 * plugin's `ScopeIconSymbols`). Bound to the scope it is mounted in: a nested
 * scope does not inherit it.
 */
export function RuntimeSymbolScope({
  store,
  children,
}: {
  store: RuntimeSymbolStore;
  children: ReactNode;
}): ReactNode {
  const scope = usePluginScopeId();
  return createElement(
    RuntimeSymbolContext.Provider,
    { value: { store, scope } },
    children,
  );
}

const unsourcedByScope = new Map<string, RuntimeSymbolStore>();

/**
 * The store this component's saved icons draw from: outside every plugin
 * scope the page's; inside one, the store mounted in THAT scope — or, when the
 * scope mounted none, one that throws on any saved icon (never the page's).
 */
export function useRuntimeSymbolStore(): RuntimeSymbolStore {
  const scope = usePluginScopeId();
  const mounted = useContext(RuntimeSymbolContext);
  if (mounted !== null && mounted.scope === scope) return mounted.store;
  if (scope === null) return pageRuntimeSymbols;
  let refusing = unsourcedByScope.get(scope);
  if (refusing === undefined) {
    refusing = unsourced(scope);
    unsourcedByScope.set(scope, refusing);
  }
  return refusing;
}

/**
 * Where a sprite family's glyphs (Lucide) drawn here come from: the store
 * mounted in this plugin scope when it mounted one (its server draws them),
 * else the page's — never the refusing store of a scope that mounted none,
 * since a family glyph is no saved data of the scope's.
 */
export function useFamilyGlyphStore(): RuntimeSymbolStore {
  const scope = usePluginScopeId();
  const mounted = useContext(RuntimeSymbolContext);
  if (mounted !== null && mounted.scope === scope) return mounted.store;
  return pageRuntimeSymbols;
}
