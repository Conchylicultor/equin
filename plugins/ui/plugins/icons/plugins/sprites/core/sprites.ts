import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveValue } from "@plugins/network/plugins/live/core";

export const IconSpritesSchema = z.object({
  /**
   * What the sprites are a function of: the manifest's names and the installed
   * Iconify sets. Every sprite URL carries it, which is what lets the route
   * serve them as immutable.
   */
  manifestHash: z.string(),
  /** Sprite key → a whole `<svg>…</svg>` of `<symbol>`s. */
  sprites: z.record(z.string(), z.string()),
});
export type IconSprites = z.infer<typeof IconSpritesSchema>;

/**
 * The RESIDENT sprites: the default style's two (at rest and active) plus the
 * brands. Preloaded, so the boot snapshot hydrates them before first paint and
 * no icon ever renders against a missing symbol in the default theme. A scope
 * themed to another style fetches that style's sprite from
 * {@link spriteEndpoint} on demand. External: the truth is the manifest compiled into this process
 * and node_modules, neither of which changes while it runs.
 */
export const residentSprites = liveValue("icons.sprites", {
  schema: IconSpritesSchema,
  preload: "boot-and-keep",
});

/**
 * One sprite (`image/svg+xml`), content-addressed by the manifest hash in its
 * path, so it is served immutable. `key` is a style key, `brands` or `seti`
 * (the Seti file-type glyphs, never resident: fetched when the first one mounts).
 */
export const spriteEndpoint = defineEndpoint({
  route: "GET /api/icons/sprite/:hash/:key",
  response: blob("image/svg+xml"),
});

export const SavedIconSpritesSchema = z.object({
  /**
   * What a runtime symbol's drawing is a function of: the installed Material
   * Symbols sets. Every {@link runtimeSymbolsEndpoint} URL carries it.
   */
  symbolsHash: z.string(),
  /** Every saved name some saved-icon source reports, sorted. */
  names: z.array(z.string()),
  /**
   * Default style key → a whole `<svg>` of `<symbol id="msr-<key>-<name>">`s,
   * one per name: the saved icons drawable at first paint in the default style
   * (and, under any other style, until that style's symbols load).
   */
  sprites: z.record(z.string(), z.string()),
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
});

/**
 * A counter a saved-icon source that is NOT in Postgres (a config) bumps when
 * its names may have changed; {@link savedIconSprites} recomputes on it. Read by
 * nothing else.
 */
export const savedIconsChanged = liveValue("icons.saved-icons-changed", {
  schema: z.number(),
});

/**
 * Runtime (saved) symbols in one style (`image/svg+xml`): `names` is a
 * comma-separated, sorted, duplicate-free list of saved symbol names, so the URL
 * is content-addressed with `hash` (the sets' {@link SavedIconSprites.symbolsHash})
 * and served immutable. `key` is a style key.
 */
export const runtimeSymbolsEndpoint = defineEndpoint({
  route: "GET /api/icons/symbols/:hash/:key",
  query: z.object({ names: z.string() }),
  response: blob("image/svg+xml"),
});
