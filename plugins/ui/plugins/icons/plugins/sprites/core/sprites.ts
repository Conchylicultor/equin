import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";

// The sprites are built from the icon sets installed on the computer (and the
// manifest compiled into the desktop's backend), so every declaration here
// needs it: a host without the computer answers them unavailable. The page's
// sprites come from the page's own server (`web/internal/sprite-host.tsx`).
const SPRITES = { feature: "Icon sprites" } as const;

export const IconSpritesSchema = z.object({
  /**
   * What the sprites are a function of: the manifest's names and the installed
   * Iconify sets. Every on-demand {@link iconSprite} read carries it, which
   * is what makes that read immutable: a tab whose resident sprites came from
   * another process's manifest is refused, not sent a mismatched sprite.
   */
  manifestHash: z.string(),
  /** Sprite key → a whole `<svg>…</svg>` of `<symbol>`s. */
  sprites: wholeRecord(z.string(), {
    reason: "the resident sprites — the default style's two and the brands",
  }),
});
export type IconSprites = z.infer<typeof IconSpritesSchema>;

/**
 * The RESIDENT sprites: the default style's two (at rest and active) plus the
 * brands. Preloaded, so the boot snapshot hydrates them before first paint and
 * no icon ever renders against a missing symbol in the default theme. A scope
 * themed to another style reads that style's sprite from {@link iconSprite} on
 * demand. External: the truth is the manifest compiled into this process
 * and node_modules, neither of which changes while it runs.
 */
export const residentSprites = liveValue("icons.sprites", {
  schema: IconSpritesSchema,
  preload: "boot-and-keep",
  needsMachine: SPRITES,
});

/**
 * One sprite, by key: a whole `<svg>…</svg>` of `<symbol>`s. `key` is a style
 * key, `brands`, `seti` or `lucide` — read on demand for a style no resident
 * sprite covers (a scope themed to rounded, say) and for a sprite that is never
 * resident (the Seti file-type glyphs, the Lucide glyphs: wanted the first
 * time one mounts). Content-addressed by `hash`, the manifest hash the tab's
 * resident sprites carry ({@link IconSprites.manifestHash}), so a tuple's
 * answer never changes: `immutable`. Read over HTTP (on demand), as the
 * endpoint it replaces was: a sprite is a whole style's symbols, asked for once
 * per page, so it never rides the socket.
 *
 * Refused `unknown-key` — a key that names no sprite — and `stale-manifest` —
 * `hash` is not the serving process's (the tab predates a restart that changed
 * the manifest; reloading the page is the remedy).
 */
export const iconSprite = liveValue("icons.sprite", {
  schema: z.string(),
  params: ["hash", "key"],
  load: "on-demand",
  refusals: ["unknown-key", "stale-manifest"],
  needsMachine: SPRITES,
});

export const SavedIconSpritesSchema = z.object({
  /**
   * What a runtime symbol's answer is a function of: the installed Material
   * Symbols sets, the saved-name list and the symbol build's version. Every
   * {@link runtimeSymbolsValue} tuple carries it.
   */
  symbolsHash: z.string(),
  /** Every saved name some saved-icon source reports, sorted. */
  names: wholeList(z.string(), {
    reason:
      "every saved icon name — each picked by hand, and every one must be drawable at first paint",
  }),
  /**
   * Default style key → a whole `<svg>` of `<symbol id="msr-<key>-<name>">`s,
   * one per name: the saved icons drawable at first paint in the default style
   * (and, under any other style, until that style's symbols load).
   */
  sprites: wholeRecord(z.string(), {
    reason: "one sprite per default style key — a handful",
  }),
});
export type SavedIconSprites = z.infer<typeof SavedIconSpritesSchema>;

/**
 * The RESIDENT saved-icon symbols: the default style's drawing of every name a
 * saved-icon source (`defineSavedIconSource`, saved-sources/server) reports — agents' avatars,
 * page icons, configured category and preprompt avatars. Preloaded, so stored
 * icons are on screen at first paint. Recomputed when a source's tables change
 * (DB-backed) or a source's config changes (the {@link savedIconsChanged} tick).
 */
export const savedIconSprites = liveValue("icons.saved-sprites", {
  schema: SavedIconSpritesSchema,
  preload: "boot-and-keep",
  needsMachine: SPRITES,
});

/**
 * A counter a saved-icon source that is NOT in Postgres (a config) bumps when
 * its names may have changed; {@link savedIconSprites} recomputes on it. Read by
 * nothing else.
 */
export const savedIconsChanged = liveValue("icons.saved-icons-changed", {
  schema: z.number(),
  needsMachine: SPRITES,
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
 * `hash` ({@link SavedIconSprites.symbolsHash}) and its answer never
 * changes: `immutable`. `key` is a style key. Read on demand (over HTTP), one
 * tuple per style per frame of wants (the sprites plugin's runtime-symbol
 * loader batches `<Icon>`'s wants).
 *
 * Refused `unknown-key` (no such style key), `stale-symbols` (`hash` is not
 * the serving process's: the tab predates a restart that changed the sets,
 * the name list or the symbol build —
 * reloading is the remedy), `invalid-names` (empty, unsorted, duplicated or
 * over the cap) and `unknown-name` (a name that is not a saved symbol name).
 */
export const runtimeSymbolsValue = liveValue("icons.runtime-symbols", {
  schema: z.string(),
  params: ["hash", "key", "names"],
  load: "on-demand",
  refusals: ["unknown-key", "stale-symbols", "invalid-names", "unknown-name"],
  needsMachine: SPRITES,
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
