/**
 * The version of the cover renderers' OUTPUT. Part of every cache key
 * (`sha256(contentHash|COVER_RENDER_VERSION)`), so bumping it re-renders every
 * cover on its next request instead of serving art drawn by older code.
 *
 * Bump it whenever a change to `roll-cover.ts`, `staff-cover.ts` or
 * `window.ts` changes the bytes they produce for the same Score.
 */
export const COVER_RENDER_VERSION = 1;
