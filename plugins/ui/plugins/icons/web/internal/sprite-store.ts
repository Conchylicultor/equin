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

/** The `<symbol id>`s of each held sprite's markup, built on first ask. */
const symbolIds = new Map<string, ReadonlySet<string>>();

/**
 * Does held sprite `key` have a `<symbol id="<id>">`? `undefined` while the
 * sprite is not held (a loading state, not an answer). A regex over the
 * sprite builder's own markup — no `DOMParser`, so a server render (a static
 * render to HTML) answers the same.
 */
export function spriteHolds(key: SpriteKey, id: string): boolean | undefined {
  const markup = sprites.get(key);
  if (markup === undefined) return undefined;
  let ids = symbolIds.get(markup);
  if (ids === undefined) {
    ids = new Set(
      [...markup.matchAll(/<symbol\b[^>]*?\sid="([^"]+)"/g)].map((m) => m[1]!),
    );
    // One entry per sprite markup the page ever held: bounded by the sheet.
    symbolIds.set(markup, ids);
  }
  return ids.has(id);
}

/** The whole `<svg>` sprite `key` is held as, or `undefined` while it is not here. */
export function spriteMarkup(key: SpriteKey): string | undefined {
  return sprites.get(key);
}

// Every read here is of this module's in-memory state, so a server render (a
// static render to HTML) reads the sprites provided before it ran.
export function useSpriteLoaded(key: SpriteKey): boolean {
  const read = () => sprites.has(key);
  return useSyncExternalStore(subscribe, read, read);
}

export function useSprites(): readonly (readonly [SpriteKey, string])[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
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
  return useSyncExternalStore(
    subscribeWanted,
    () => wantedSnapshot,
    () => wantedSnapshot,
  );
}
