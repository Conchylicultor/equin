import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";

/**
 * Why a render produced no picture. Every arm is a state the card renders, not
 * an error swallowed into a missing image:
 *
 * - `subresource-failed` — a script or stylesheet the page needs never loaded
 *   (offline, dead CDN). The page technically rendered; what it rendered is a
 *   lie about the prototype, so it is never cached.
 * - `blank-page` — the document loaded but painted nothing (a prototype that
 *   throws on boot). Same reasoning.
 * - `render-timeout` — the page never settled inside the budget. A partial
 *   screenshot is indistinguishable from a finished one, so we take none.
 * - `browser-unavailable` — chromium could not be launched at all, or its
 *   install failed. (Not installed YET is not a failure: that is the
 *   `waiting-for-browser` state.)
 */
export const ThumbnailFailureKindSchema = z.enum([
  "subresource-failed",
  "blank-page",
  "render-timeout",
  "browser-unavailable",
]);
export type ThumbnailFailureKind = z.infer<typeof ThumbnailFailureKindSchema>;

/**
 * One prototype's thumbnail state.
 *
 * `key` is the content fingerprint the state describes — present on `ready`
 * (it addresses the cached PNG) *and* on `failed`, so a permanently broken
 * prototype is not re-rendered on every unrelated edit: the sync compares the
 * folder's current fingerprint against the one that already failed.
 */
export const ThumbnailStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), key: z.string() }),
  z.object({ status: z.literal("rendering") }),
  // Chromium (an on-demand dependency) is not installed yet: its install has
  // been requested, and the render is re-enqueued when it settles. Not a
  // failure of the prototype, and not cached as one.
  z.object({ status: z.literal("waiting-for-browser"), message: z.string() }),
  z.object({
    status: z.literal("failed"),
    key: z.string(),
    kind: ThumbnailFailureKindSchema,
    message: z.string(),
  }),
]);
export type ThumbnailState = z.infer<typeof ThumbnailStateSchema>;

/**
 * Thumbnail state for every prototype, keyed by directory slug. Push-based and
 * served from the backend's in-memory map (`source: "external"`): the render
 * job notifies on completion, so a card updates itself with no polling. A
 * prototype absent from the LOADED map has no state yet (nothing has looked at
 * it, or the backend just booted) — which the card renders as its fallback
 * cover, the same as `rendering`. Before the map loads the value is pending,
 * never an empty map standing in for it.
 */
export const prototypeThumbnails = liveValue("prototypes.thumbnails", {
  schema: wholeRecord(ThumbnailStateSchema, {
    reason:
      "one state per prototype — bounded by the prototype list the gallery holds whole",
  }),
});

/**
 * One cached thumbnail, `GET /api/prototype-thumbs/<key>.png`.
 *
 * Deliberately NOT under `/api/prototypes/…`: that prefix already owns
 * `GET /api/prototypes/:name/:file`, which matches any two segments, so a
 * thumbnail nested under it would be shadowed by (or shadow) raw file serving.
 * Raw handler (it returns image bytes with its own cache headers) in the
 * `machine/` half: the cache is on disk, so the route is desktop-only.
 */
export const getPrototypeThumbnail = defineEndpoint({
  route: "GET /api/prototype-thumbs/:key",
  response: blob(),
  needsMachine: { feature: "Prototype previews" },
});

/**
 * A rendered thumbnail, loaded with `useAssetSrc`. The path carries the
 * content fingerprint, so the response is genuinely immutable — an edit yields
 * a different path rather than a stale hit, and the browser never has to
 * revalidate.
 */
export function prototypeThumbnailAsset(key: string): AssetPath {
  return assetPath(getPrototypeThumbnail, { key: `${key}.png` });
}
