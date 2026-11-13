import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  BRANDS_SPRITE,
  DEFAULT_STYLE_KEYS,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";

// The icon manifest is compiled into the desktop's backend, so its declaration
// needs the computer: a host without it answers it unavailable. Every sprite
// value below is portable: a host draws through its `SpriteDrawer` /
// `RuntimeSymbolDrawer` (the installed sets on the computer, bundled sets on
// a browser host), and every scope reads them from its own server.
const SPRITES = { feature: "Icon sprites" } as const;

/**
 * The sprites the page holds from its first paint: the default style's two
 * (at rest and active) plus the brands. Their markup is never in the boot
 * snapshot (it was most of it, re-sent on every load): the shell's head
 * fetches each as a content-addressed asset ({@link getSpriteAsset}, which the
 * browser caches `immutable`) and the sprites plugin's boot task provides them
 * before the first render. A key the head did not provide (no head, or one
 * written for another hash) is read as {@link iconSprite} like any other.
 */
export const RESIDENT_SPRITE_KEYS: readonly SpriteKey[] = [
  ...DEFAULT_STYLE_KEYS,
  BRANDS_SPRITE,
];

/**
 * One sprite, by key: a whole `<svg>…</svg>` of `<symbol>`s. `key` is a style
 * key, `brands`, `seti` or `lucide` — read on demand for a style no resident
 * sprite covers (a scope themed to rounded, say) and for a sprite that is never
 * resident (the Seti file-type glyphs, the Lucide glyphs: wanted the first
 * time one mounts). Content-addressed by `hash`, the serving host's
 * {@link spriteHash}, so a tuple's answer never changes:
 * `immutable`. Read over HTTP (on demand), as the endpoint it replaces was: a
 * sprite is a whole style's symbols, asked for once per page, so it never
 * rides the socket.
 *
 * Portable: drawn through the host's `SpriteDrawer` — the icon sets installed
 * on the computer on the desktop, the sets bundled with a browser host's
 * worker there — so a plugin scope (the demo) reads its sprites from its own
 * server (`ScopeIconSymbols`).
 *
 * Refused `unknown-key` — a key that names no sprite — `stale-manifest` —
 * `hash` is not the serving host's (the tab predates a restart that changed
 * the manifest: {@link spriteHash} is pushed again with the new hash and the
 * read re-keys off it — never a fault, the host waits) — and `not-drawn-here` — a
 * sprite this host's drawer holds no set for (a browser host draws the Seti
 * and Lucide sprites only).
 */
export const iconSprite = liveValue("icons.sprite", {
  schema: z.string(),
  params: ["hash", "key"],
  load: "on-demand",
  refusals: ["unknown-key", "stale-manifest", "not-drawn-here"],
});

/**
 * The hash every {@link iconSprite} tuple read from this host carries: what
 * its drawer's sprites are a function of. Fixed for the host's life. A scope
 * reads it from its own server before asking for a sprite; so does the page.
 */
export const spriteHash = liveValue("icons.sprite-hash", {
  schema: z.string(),
  // The page's resident sprites are addressed by it: known at the first
  // render, so a resident key the head did not provide is asked for at once.
  preload: "boot-and-keep",
});

/**
 * What a runtime symbol's drawing is a function of — the serving host's
 * drawer (the Material Symbols set it draws from), the savable-name list and
 * the symbol build's version. Every {@link runtimeSymbolsValue} tuple and every
 * {@link getSavedSpriteAsset} path carries it. Fixed for the host's life;
 * preloaded, so the page's runtime-symbol loader can ask at once.
 */
export const savedSymbolsHash = liveValue("icons.symbols-hash", {
  schema: z.string(),
  preload: "boot-and-keep",
});

/**
 * The saved-icon sprites, as {@link getSavedSpriteAsset} answers them: every
 * name a saved-icon source (`defineSavedIconSource`, saved-sources/server)
 * reports — agents' avatars, configured category and preprompt avatars, tags'
 * icons — and, per default style key, one `<svg>` of their
 * `<symbol id="msr-<key>-<name>">`s.
 */
export const SavedSpriteAssetSchema = z.object({
  names: wholeList(z.string(), {
    reason:
      "every saved icon name — each picked by hand, and every one must be drawable at first paint",
  }),
  sprites: wholeRecord(z.string(), {
    reason: "one sprite per default style key — a handful",
  }),
});
export type SavedSpriteAsset = z.infer<typeof SavedSpriteAssetSchema>;

/**
 * `GET /api/icons/sprite-assets/:hash/:key` — one sprite (`image/svg+xml`),
 * content-addressed by the host's {@link spriteHash}: served
 * `public, max-age=31536000, immutable`, so a warm page load reads it from the
 * browser's cache and a cold one fetches it in parallel with the code. A hash
 * that is not the host's is a 409 (the head that named it predates a restart
 * that changed the manifest), a key the host's drawer does not draw a 404.
 * Requested by the shell's head script only — page code reads a sprite as
 * {@link iconSprite}.
 */
export const getSpriteAsset = defineEndpoint({
  route: "GET /api/icons/sprite-assets/:hash/:key",
  response: blob("image/svg+xml"),
});

/**
 * `GET /api/icons/saved-sprite-assets/:hash` — the saved-icon sprites of the
 * default style keys ({@link SavedSpriteAsset}, JSON) under the host's
 * {@link savedSymbolsHash}. Its names move whenever a user picks an icon, so
 * it is served `no-cache` with an ETag over them: a warm page load
 * revalidates (a 304, no body) instead of downloading it again. A hash that is
 * not the host's is a 409. Requested by the shell's head script only.
 */
export const getSavedSpriteAsset = defineEndpoint({
  route: "GET /api/icons/saved-sprite-assets/:hash",
  response: blob("application/json"),
});

/**
 * At most this many names in one {@link runtimeSymbolsValue} tuple: the read
 * travels as a URL (an on-demand value is fetched over HTTP), which stays
 * well under any proxy's limit. The loader splits a larger batch.
 */
export const MAX_RUNTIME_SYMBOLS_PER_READ = 200;

/**
 * Runtime (saved) symbols in one style: a whole `<svg>` of
 * `<symbol id="msr-<key>-<name>">`s. `names` is a comma-separated, sorted,
 * duplicate-free list of at most {@link MAX_RUNTIME_SYMBOLS_PER_READ} saved
 * symbol names — one spelling per set, so the tuple is content-addressed with
 * `hash` ({@link savedSymbolsHash}) and its answer never
 * changes: `immutable`. `key` is a style key. Read on demand (over HTTP), one
 * tuple per style per frame of wants (the sprites plugin's runtime-symbol
 * loader batches `<Icon>`'s wants).
 *
 * Refused `unknown-key` (no such style key), `stale-symbols` (`hash` is not
 * the serving process's: the tab predates a restart that changed the sets or
 * the symbol build, or the saved-name list moved — the page reads the
 * new hash from {@link savedSymbolsHash} and the read re-keys off it), `invalid-names` (empty, unsorted, duplicated or
 * over the cap) and `unknown-name` (a name that is not a saved symbol name).
 */
export const runtimeSymbolsValue = liveValue("icons.runtime-symbols", {
  schema: z.string(),
  params: ["hash", "key", "names"],
  load: "on-demand",
  refusals: ["unknown-key", "stale-symbols", "invalid-names", "unknown-name"],
});

const IconManifestSchema = z.object({
  /**
   * Every Material Symbols name some code draws — the `symbol("…")` literals
   * the build scanned, sorted — so each is a `SymbolName` tsc checked at its
   * call site, and one the sprites carry.
   */
  symbols: wholeList(z.string(), {
    reason:
      "the symbol names the build scanned from the code — fixed for the process, and the Icons pane lists them all",
  }),
});

/**
 * The build's icon manifest as data, for a surface that lists the icons the app
 * draws (Debug → Icons). Not preloaded: only that surface reads it. Fixed for
 * the process — the manifest is compiled into the server.
 */
export const iconManifest = liveValue("icons.manifest", {
  schema: IconManifestSchema,
  needsMachine: SPRITES,
});
