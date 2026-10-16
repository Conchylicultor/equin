import { useSyncExternalStore } from "react";
import type { SpriteKey } from "../../core";

/**
 * The sprites the page holds: one `<svg>` of `<symbol>`s per sprite key, filled
 * by the sprite host (the resident ones from the boot snapshot, the rest on
 * demand) and drawn by `<IconSpriteSheet>`. `<Icon>` asks whether its style's
 * sprite is here yet, and draws the default style's symbol until it is.
 */
const sprites = new Map<SpriteKey, string>();
const listeners = new Set<() => void>();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: one sprite sheet per document serves every surface, and a sprite is the same bytes wherever it is drawn
let snapshot: readonly (readonly [SpriteKey, string])[] = [];

/** Subscribe to every sprite landing (`provideSprite`). */
export function subscribeSprites(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const subscribe = subscribeSprites;

/** Hold `markup` (a whole `<svg>…</svg>`) as sprite `key`. A no-op when it is already there, byte for byte. */
export function provideSprite(key: SpriteKey, markup: string): void {
  if (sprites.get(key) === markup) return;
  sprites.set(key, markup);
  snapshot = [...sprites.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const l of listeners) l();
}

export function hasSprite(key: SpriteKey): boolean {
  return sprites.has(key);
}

/** The whole `<svg>` sprite `key` is held as, or `undefined` while it is not here. */
export function spriteMarkup(key: SpriteKey): string | undefined {
  return sprites.get(key);
}

export function useSpriteLoaded(key: SpriteKey): boolean {
  return useSyncExternalStore(subscribe, () => sprites.has(key));
}

export function useSprites(): readonly (readonly [SpriteKey, string])[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

// Sprites no theme scope asks for but some mounted icon needs: a sprite that is
// never resident (the Seti file-type glyphs) is wanted the first time an icon
// drawing from it mounts, and stays wanted — the sheet keeps it once loaded.
const wanted = new Set<SpriteKey>();
const wantListeners = new Set<() => void>();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global like the sprite map above: one sheet serves every surface
let wantedSnapshot: readonly SpriteKey[] = [];

function subscribeWanted(listener: () => void): () => void {
  wantListeners.add(listener);
  return () => wantListeners.delete(listener);
}

/** Ask the sprite host to load sprite `key` (a no-op once asked). */
export function wantSprite(key: SpriteKey): void {
  if (wanted.has(key)) return;
  wanted.add(key);
  wantedSnapshot = [...wanted].sort();
  for (const l of wantListeners) l();
}

/** Every sprite some mounted icon has asked for (beyond the theme scopes' styles). */
export function useWantedSprites(): readonly SpriteKey[] {
  return useSyncExternalStore(subscribeWanted, () => wantedSnapshot);
}
