import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  BRANDS_SPRITE,
  type GlyphKey,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";

// The icon manifest is compiled into the desktop's backend, so its declaration
// needs the computer: a host without it answers it unavailable. Every sprite
// value below is portable: a host draws through its `SpriteDrawer` /
// `RuntimeSymbolDrawer` (the installed sets on the computer, bundled sets on
// a browser host), and every scope reads them from its own server.
const SPRITES = { feature: "Icon sprites" } as const;

/**
 * The whole sprites the page holds from its first paint: the brands (six
 * marks). Never in the boot snapshot: the shell's head fetches it as a
 * content-addressed asset ({@link getSpriteAsset}, cached `immutable`) and the
 * sprites plugin's boot task provides it before the first render. Every
 * Material and Lucide glyph is loaded glyph by glyph instead
 * ({@link runtimeSymbolsValue}) — a page holds what it draws, never a set.
 */
export const RESIDENT_SPRITE_KEYS: readonly SpriteKey[] = [BRANDS_SPRITE];

/**
 * One whole sprite, by key: a whole `<svg>…</svg>` of `<symbol>`s. The page
 * reads `brands` (when the head did not provide it) and `seti` (the file-type
 * glyphs, wanted the first time one mounts); every other key is loaded glyph
 * by glyph ({@link runtimeSymbolsValue}), and the whole Material and Lucide
 * sprites are kept for inspection and the desktop's own tools. Content-addressed by `hash`, the serving host's
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
 * The hash every {@link iconSprite} tuple read from this host carries — and
 * every {@link runtimeSymbolsValue} tuple of a Lucide key: what its drawer's
 * sprites are a function of (the manifest, the sets, the Lucide map and
 * tuning). Fixed for the host's life. A scope reads it from its own server
 * before asking for a sprite; so does the page.
 */
export const spriteHash = liveValue("icons.sprite-hash", {
  schema: z.string(),
  // The page's first-frame glyphs are addressed by it: known at the first
  // render, so the first frame's batch is asked for at once.
  preload: "boot-and-keep",
});

/**
 * What a Material glyph's drawing is a function of — the serving host's
 * drawer (the Material Symbols set it draws from), the drawable-name list and
 * the symbol build's version; never the code's icon manifest. Every
 * {@link runtimeSymbolsValue} / {@link getGlyphAsset} address of a Material
 * style carries it. Fixed for the host's life; preloaded, so the page's glyph
 * loader can ask at once.
 */
export const savedSymbolsHash = liveValue("icons.symbols-hash", {
  schema: z.string(),
  preload: "boot-and-keep",
});

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
 * `GET /api/icons/glyph-assets/:hash/:key/:names` — one batch of glyphs
 * (`image/svg+xml`): exactly what {@link runtimeSymbolsValue} answers for the
 * same tuple, served `public, max-age=31536000, immutable` — the path is the
 * content's address (`hash` the key's own hash, `names` sorted and
 * duplicate-free). The shell's head fetches the batches the page's last first
 * frame drew at t0 (a warm load reads them from the browser's cache); a hash
 * that is not the host's is a 409. Requested by the head script only — page
 * code reads a batch as {@link runtimeSymbolsValue}.
 */
export const getGlyphAsset = defineEndpoint({
  route: "GET /api/icons/glyph-assets/:hash/:key/:names",
  response: blob("image/svg+xml"),
});

/**
 * At most this many names in one {@link runtimeSymbolsValue} tuple: the read
 * travels as a URL (an on-demand value is fetched over HTTP), which stays
 * well under any proxy's limit. The loader splits a larger batch.
 */
export const MAX_RUNTIME_SYMBOLS_PER_READ = 200;

/**
 * Glyphs, by name, in one {@link GlyphKey}: a whole `<svg>` of `<symbol>`s,
 * ids as `glyphId` spells them (`msr-<styleKey>-<name>` for a Material style —
 * code `symbol("…")`s and saved icons alike —, the Lucide sprite's own ids for
 * `lucide` / `lucide-active`). `names` is a comma-separated, sorted,
 * duplicate-free list of at most {@link MAX_RUNTIME_SYMBOLS_PER_READ} Material
 * names — one spelling per set, so the tuple is content-addressed with
 * `hash` and its answer never changes: `immutable`. `hash` is the KEY's own
 * hash — {@link savedSymbolsHash} for a Material style (no manifest: a new
 * icon in the code moves none of them), {@link spriteHash} for a Lucide key —
 * so a change re-addresses only the glyphs it can change. A name the host
 * draws no glyph for is answered without its symbol (the page draws the
 * missing-glyph marker and reports it). Read on demand (over HTTP), one
 * tuple per key per frame of wants (the sprites plugin's glyph loader
 * batches `<Icon>`'s wants); a page's first frame reads them before it
 * paints.
 *
 * Refused `unknown-key` (no glyph key), `stale-symbols` (`hash` is not the
 * serving process's: the tab predates a restart that changed the sets, the
 * build or — for Lucide — the manifest; the page reads the new hash and the
 * read re-keys off it) and `invalid-names` (empty, unsorted, duplicated or over
 * the cap).
 */
export const runtimeSymbolsValue = liveValue("icons.runtime-symbols", {
  schema: z.string(),
  params: ["hash", "key", "names"],
  load: "on-demand",
  refusals: ["unknown-key", "stale-symbols", "invalid-names"],
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
