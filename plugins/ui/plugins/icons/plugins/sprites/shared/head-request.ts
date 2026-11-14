/**
 * The icon requests the SPA shell's head starts, handed to the sprites
 * plugin's boot task. The head script (rendered by the server half's
 * `DocumentHead.Fragment`, `server/internal/head.ts`) fetches, while the HTML
 * is still being parsed — in parallel with the module downloads and the boot
 * snapshot —
 *
 * - the resident whole sprites (the brands), and
 * - the glyph batches this page's last first frame drew, remembered in
 *   `localStorage` ({@link FIRST_FRAME_MEMORY_OWNER}) — content-addressed assets,
 *   so a warm load reads them from the browser's cache and its first frame
 *   wants nothing;
 *
 * and parks the in-flight responses on the page's global object under
 * {@link HEAD_REQUEST_GLOBAL}; the boot task takes them and provides them
 * before the first render.
 */
export const HEAD_REQUEST_GLOBAL = "__equinIconSprites";

/**
 * The web-storage owner whose entries remember the glyph batches each page's
 * first frame drew (`icons.first-frame`, a `pageWide` store: one entry per
 * page, {@link FIRST_FRAME_PAGE_JS}). Written by the sprite host once the
 * first frame's glyphs have landed; read by the head script on the next load
 * — under the store's key (`ownerPrefix(owner) + page`), its value the `v` of
 * the store's `{ v, ts, s }` envelope.
 */
export const FIRST_FRAME_MEMORY_OWNER = "ui.icons.first-frame";

/** One remembered glyph batch: an address of `GET /api/icons/glyph-assets/:hash/:key/:names`. */
export interface GlyphBatchAddress {
  readonly hash: string;
  readonly key: string;
  /** Comma-joined, sorted, duplicate-free. */
  readonly names: string;
}

/**
 * The page a memory entry belongs to, as the head script computes it: the
 * path's first segment (`/agents/c/…` → `agents`) — an app's routes share one
 * first frame's chrome, and the batches of a route that drew more are kept
 * beside the others. Parked with the requests ({@link HeadSpriteRequests}),
 * so the memory is written under exactly the key the next head reads.
 */
export const FIRST_FRAME_PAGE_JS = `(location.pathname.replace(/\\/{2,}/g, "/").split("/")[1] ?? "")`;

/** At most this many glyphs remembered per page: past it, the oldest batches are dropped. */
export const FIRST_FRAME_MEMORY_MAX_GLYPHS = 400;

/** What the head script parks. */
export interface HeadSpriteRequests {
  /** `performance.now()` when the head script issued the requests. */
  startMs: number;
  /** The resident sprites (`RESIDENT_SPRITE_KEYS`), under the host's sprite hash. */
  resident: {
    hash: string;
    sprites: Readonly<Record<string, Promise<Response>>>;
  };
  /** The page whose first-frame memory the head read ({@link FIRST_FRAME_PAGE_JS}). */
  page: string;
  /** The remembered first-frame glyph batches, each with its request. */
  glyphs: readonly (GlyphBatchAddress & { response: Promise<Response> })[];
  /** Why the memory could not be read (storage blocked, a corrupt entry), else `null`. */
  memoryError: string | null;
}
