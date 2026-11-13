/**
 * The sprite requests the SPA shell's head starts, handed to the sprites
 * plugin's boot task. The head script (rendered by the server half's
 * `DocumentHead.Fragment`, `server/internal/head.ts`) fetches the resident
 * sprites and the saved-icon sprites while the HTML is still being parsed — in
 * parallel with the module downloads and the boot snapshot — and parks the
 * in-flight responses on the page's global object under this name; the boot
 * task takes them and provides the sprites before the first render.
 */
export const HEAD_REQUEST_GLOBAL = "__equinIconSprites";

/** What the head script parks. */
export interface HeadSpriteRequests {
  /** `performance.now()` when the head script issued the requests. */
  startMs: number;
  /** The resident sprites (`RESIDENT_SPRITE_KEYS`), under the host's sprite hash. */
  resident: {
    hash: string;
    sprites: Readonly<Record<string, Promise<Response>>>;
  };
  /** The saved-icon sprites (`SavedSpriteAsset`), under the host's symbols hash. */
  saved: Promise<Response>;
}
