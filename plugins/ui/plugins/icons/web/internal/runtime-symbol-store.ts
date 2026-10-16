import { useEffect, useSyncExternalStore } from "react";
import type { StyleKey } from "../../core";

/**
 * The RUNTIME symbols the page holds: saved (user-picked) names, which are not
 * in the build's manifest and so not in any sprite. They arrive in chunks — the
 * resident saved-icon sprites from the boot snapshot, and each on-demand batch
 * the sprites plugin fetches — and `<IconSpriteSheet>` renders every chunk.
 *
 * `<Icon>` on a runtime symbol asks for its (style key, name) here; a name no
 * chunk holds yet is a WANT, handed to whichever loader is installed (the
 * sprites plugin's batching fetcher). This plugin sits below the network layer,
 * so the loader is installed from above rather than imported.
 */

export interface RuntimeSymbolEntry {
  readonly styleKey: StyleKey;
  readonly name: string;
}

interface Chunk {
  readonly markup: string;
  readonly entries: readonly RuntimeSymbolEntry[];
}

type WantListener = (entry: RuntimeSymbolEntry) => void;

const chunks = new Map<string, Chunk>();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design, like the sprite store: one sheet per document serves every surface
let provided = new Set<string>();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design (see above): the sorted chunk list the sheet renders
let snapshot: readonly (readonly [string, string])[] = [];
const listeners = new Set<() => void>();
const pendingWants = new Map<string, RuntimeSymbolEntry>();
let wantListener: WantListener | null = null;

function entryKey(styleKey: StyleKey, name: string): string {
  return `${styleKey}\u0000${name}`;
}

/** Subscribe to every runtime-symbol chunk landing (`provideRuntimeSymbols`). */
export function subscribeRuntimeSymbols(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const subscribe = subscribeRuntimeSymbols;

/**
 * Hold `markup` (a whole `<svg>` of `<symbol id="msr-<styleKey>-<name>">`s) as
 * chunk `chunkId`, replacing what that chunk held. `entries` are the symbols it
 * carries. A no-op when the chunk already holds these bytes.
 */
export function provideRuntimeSymbols(
  chunkId: string,
  markup: string,
  entries: readonly RuntimeSymbolEntry[],
): void {
  if (chunks.get(chunkId)?.markup === markup) return;
  chunks.set(chunkId, { markup, entries });
  const next = new Set<string>();
  for (const chunk of chunks.values()) {
    for (const e of chunk.entries) next.add(entryKey(e.styleKey, e.name));
  }
  provided = next;
  for (const key of [...pendingWants.keys()]) {
    if (provided.has(key)) pendingWants.delete(key);
  }
  snapshot = [...chunks.entries()]
    .map(([id, chunk]) => [id, chunk.markup] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const l of listeners) l();
}

export function hasRuntimeSymbol(styleKey: StyleKey, name: string): boolean {
  return provided.has(entryKey(styleKey, name));
}

/**
 * Install the loader every want is handed to. Wants made before it was
 * installed are replayed to it. One loader per page — a second throws.
 */
export function installRuntimeSymbolLoader(listener: WantListener): () => void {
  if (wantListener !== null) {
    throw new Error("[icons] a runtime symbol loader is already installed");
  }
  wantListener = listener;
  for (const entry of pendingWants.values()) listener(entry);
  return () => {
    if (wantListener === listener) wantListener = null;
  };
}

/** Ask the installed loader for runtime symbol `name` in `styleKey` (a no-op once held or asked). */
export function wantRuntimeSymbol(styleKey: StyleKey, name: string): void {
  const key = entryKey(styleKey, name);
  if (provided.has(key) || pendingWants.has(key)) return;
  const entry = { styleKey, name };
  pendingWants.set(key, entry);
  wantListener?.(entry);
}

/**
 * Which style key `<Icon>` can draw runtime symbol `name` from: `wanted` once a
 * chunk holds it, else `fallback` (the default style's key) while that one is
 * held, else `null` — nothing to draw yet, a loading state. Asks for `wanted`
 * when no chunk holds it. `name === null` asks for nothing (a non-runtime icon).
 */
export function useRuntimeSymbolKey(
  name: string | null,
  wanted: StyleKey,
  fallback: StyleKey,
): StyleKey | null {
  const drawn = useSyncExternalStore(subscribe, () => {
    if (name === null) return null;
    if (provided.has(entryKey(wanted, name))) return wanted;
    if (provided.has(entryKey(fallback, name))) return fallback;
    return null;
  });
  const missing = name !== null && drawn !== wanted;
  useEffect(() => {
    if (missing) wantRuntimeSymbol(wanted, name);
  }, [missing, wanted, name]);
  return drawn;
}

/** Every chunk's markup, sorted by chunk id (the sheet's order). */
export function runtimeSymbolChunks(): readonly (readonly [string, string])[] {
  return snapshot;
}

export function useRuntimeSymbolChunks(): readonly (readonly [
  string,
  string,
])[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}
