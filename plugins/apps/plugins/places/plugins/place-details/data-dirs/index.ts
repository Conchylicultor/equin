import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The places gallery's cover thumbnails: each Google place's first photo at
 * thumbnail width, one file per Google place id (`<id>.jpg`), plus an empty
 * `<id>.none` for a place Google has no photo of.
 *
 * `cache`: anything deleted here is fetched again on the next gallery view.
 * Host-global, so main and every worktree share one fetch per place.
 */
export const placeThumbnailDir = defineDataDir({
  kind: "cache",
  name: "places-thumbnails",
  owner: "apps/places/place-details",
  description:
    "Places gallery cover thumbnails — each Google place's first photo, keyed by Google place id",
  reclaim: { kind: "safe" },
});

export default [placeThumbnailDir];
