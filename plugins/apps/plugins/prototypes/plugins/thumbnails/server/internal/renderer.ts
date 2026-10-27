import { defineHostService } from "@plugins/framework/plugins/server-core/core";

/** One render asked for: a prototype, at the fingerprint its bytes had. */
export interface ThumbnailRenderRequest {
  name: string;
  key: string;
}

/**
 * What the host can do about a fingerprint with no cached PNG — a union, so a
 * host without a renderer has no `request` to call and must say why:
 *
 * - `renders` — `request` queues a render, which records its outcome on the
 *   card itself (`ready`, `failed`, `waiting-for-browser`). The desktop:
 *   headless Chromium through Playwright, one render at a time in a job.
 * - `unavailable` — nothing here can render; a miss is the card's
 *   `unavailable` state carrying `message`. A browser host: no Chromium, so the
 *   only previews are the PNGs its seed put in the cache.
 */
export type ThumbnailRendererImpl =
  | {
      readonly kind: "renders";
      request(item: ThumbnailRenderRequest): Promise<void>;
    }
  | { readonly kind: "unavailable"; message: string };

/**
 * The host's thumbnail renderer. Provided by `thumbnails#machine` on the
 * desktop and by `thumbnails/no-renderer` in a browser host. Read only by
 * `syncThumbnails` — the one place that decides what needs rendering.
 */
export const ThumbnailRenderer = defineHostService<ThumbnailRendererImpl>(
  "prototypes.thumbnail-renderer",
);
