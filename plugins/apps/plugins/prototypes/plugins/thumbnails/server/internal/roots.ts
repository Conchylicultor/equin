import { defineFileRoot } from "@plugins/infra/plugins/paths/plugins/data-files/server";

/**
 * The rendered-thumbnail cache (`cache/prototypes-thumbnails`, this plugin's
 * `data-dirs/`) as a file root: `<sha256>.png` per prototype content
 * fingerprint, flat. The computer's disk on the desktop (bound in
 * `../../machine`), memory in a browser host — where nothing renders, so the
 * only PNGs are the ones a seed wrote.
 *
 * Unwatched: every write lands through this plugin, which pushes the state
 * itself, and the PNG's URL is its fingerprint — nothing needs to hear a file
 * appear.
 */
export const thumbnailCache = defineFileRoot({
  id: "apps.prototypes.thumbnails",
  dir: "cache/prototypes-thumbnails",
});
