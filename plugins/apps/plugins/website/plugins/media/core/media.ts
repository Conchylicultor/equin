import {
  assetMirrorFile,
  type AssetMirrorPrewarm,
} from "@plugins/infra/plugins/asset-mirror/core";
import type { AssetPath } from "@plugins/infra/plugins/endpoints/core";

/** Mirror id → URL segment `/api/asset-mirror/website-media/…`. */
export const WEBSITE_MEDIA_MIRROR_ID = "website-media";

/**
 * Where the site's media lives: the assets of the `website-media` GitHub
 * release (a pre-release, so it never becomes the repo's Latest), never git.
 * Each render is a new file name (`equin-v<N>.mp4`), so a mirrored file — cached
 * once, served immutable — never changes under the same name.
 */
export const WEBSITE_MEDIA_REMOTE_BASE =
  "https://github.com/Conchylicultor/equin/releases/download/website-media";

const FILM_FILE = "equin-v20-web.mp4";
const FILM_POSTER_FILE = "equin-v20-web-poster.jpg";

/** Every file the site shows, so a release bundles them (`prewarm/`). */
export const WEBSITE_MEDIA_FILES: AssetMirrorPrewarm["files"] = [
  FILM_FILE,
  FILM_POSTER_FILE,
];

/**
 * The showcase film — `apps/website/promo-film`'s web render (`-web.mp4`:
 * ~16 MB, faststart, beside the ~70 MB master) — and its poster, a frame of
 * the film's desktop montage, as what a `<video>` loads.
 */
export const showcaseFilm: {
  readonly video: AssetPath;
  readonly poster: AssetPath;
  readonly label: string;
} = {
  video: assetMirrorFile(WEBSITE_MEDIA_MIRROR_ID, FILM_FILE),
  poster: assetMirrorFile(WEBSITE_MEDIA_MIRROR_ID, FILM_POSTER_FILE),
  label: "equin, the showcase film",
};
