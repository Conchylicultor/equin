import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import { runtimeSymbolId, type StyleKey } from "../../core";

/**
 * The RUNTIME symbols a server drew for the icons in one part of the page:
 * saved (user-picked) names, which are not in the build's manifest and so not
 * in any sprite. They arrive in chunks — the resident saved-icon sprites, and
 * each on-demand batch — read from THAT part's server by whoever installed the
 * loader (the sprites plugin), so a demo's saved icons come from the demo's
 * server and the page's from the page's.
 *
 * `<Icon>` on a runtime symbol asks its store ({@link useRuntimeSymbolStore})
 * for (style key, name); a name no chunk holds yet is a WANT, handed to the
 * store's loader. This plugin sits below the network layer, so the loader is
 * installed from above rather than imported.
 */

export interface RuntimeSymbolEntry {
  readonly styleKey: StyleKey;
  readonly name: string;
}

type WantListener = (entry: RuntimeSymbolEntry) => void;

export interface RuntimeSymbolStore {
  /** The `<symbol id>` this store's chunks draw (style, name) under. */
  symbolId(styleKey: StyleKey, name: string): string;
  hasSymbol(styleKey: StyleKey, name: string): boolean;
  /** Ask the installed loader for `name` in `styleKey` (a no-op once held or asked). */
  want(styleKey: StyleKey, name: string): void;
  /**
   * Hold `markup` (a whole `<svg>` of `<symbol id="msr-<styleKey>-<name>">`s,
   * as the server draws them) as chunk `chunkId`, replacing what that chunk
   * held. `entries` are the symbols it carries. A no-op when the chunk already
   * holds these bytes.
   */
  provide(
    chunkId: string,
    markup: string,
    entries: readonly RuntimeSymbolEntry[],
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
}

function entryKey(styleKey: StyleKey, name: string): string {
  return `${styleKey}\u0000${name}`;
}

/**
 * A store whose symbol ids carry `idPrefix` before the server's own
 * (`msr-…`), so two stores' sheets in one document never hold one id twice.
 * The page's store has none.
 */
function createStore(idPrefix: string): RuntimeSymbolStore {
  const held = new Map<
    string,
    { markup: string; entries: readonly RuntimeSymbolEntry[] }
  >();
  let provided = new Set<string>();
  let snapshot: readonly (readonly [string, string])[] = [];
  const listeners = new Set<() => void>();
  const pendingWants = new Map<string, RuntimeSymbolEntry>();
  let loader: WantListener | null = null;
  return {
    symbolId: (styleKey, name) => idPrefix + runtimeSymbolId(styleKey, name),
    hasSymbol: (styleKey, name) => provided.has(entryKey(styleKey, name)),
    want(styleKey, name) {
      const key = entryKey(styleKey, name);
      if (provided.has(key) || pendingWants.has(key)) return;
      const entry = { styleKey, name };
      pendingWants.set(key, entry);
      loader?.(entry);
    },
    provide(chunkId, raw, entries) {
      const markup =
        idPrefix === ""
          ? raw
          : raw.replaceAll('id="msr-', `id="${idPrefix}msr-`);
      // The prefix is applied by rewriting the server's own ids: a chunk whose
      // symbols it did not reach would draw nothing under `symbolId`, silently.
      if (idPrefix !== "" && entries.length > 0 && markup === raw) {
        throw new Error(
          `[icons] runtime-symbol chunk "${chunkId}" holds no id="msr-…" to scope`,
        );
      }
      if (held.get(chunkId)?.markup === markup) return;
      held.set(chunkId, { markup, entries });
      const next = new Set<string>();
      for (const chunk of held.values()) {
        for (const e of chunk.entries) next.add(entryKey(e.styleKey, e.name));
      }
      provided = next;
      for (const key of [...pendingWants.keys()]) {
        if (provided.has(key)) pendingWants.delete(key);
      }
      snapshot = [...held.entries()]
        .map(([id, chunk]) => [id, chunk.markup] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      for (const l of listeners) l();
    },
    installLoader(listener) {
      if (loader !== null) {
        throw new Error("[icons] a runtime symbol loader is already installed");
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
  };
}

/** The page's own store: every icon outside a plugin scope draws from it. */
export const pageRuntimeSymbols: RuntimeSymbolStore = createStore("");

let scopedStores = 0;

/** A store of its own, for a plugin scope's icons (see {@link RuntimeSymbolScope}). */
export function createScopedRuntimeSymbols(): RuntimeSymbolStore {
  scopedStores++;
  return createStore(`rs${scopedStores}-`);
}

const NO_CHUNKS: readonly (readonly [string, string])[] = [];

/** Every chunk of `store`, re-read when one lands. */
export function useRuntimeSymbolChunks(
  store: RuntimeSymbolStore,
): readonly (readonly [string, string])[] {
  return useSyncExternalStore(store.subscribe, store.chunks);
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
    want: refuse,
    provide: refuse,
    installLoader: refuse,
    // Every <Icon> and markup reader subscribes and lists the chunks; only a
    // saved icon asks for a symbol, which is what refuses.
    subscribe: () => () => {},
    chunks: () => NO_CHUNKS,
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
