import {
  assetMirrorFile,
  defineAssetMirrorSource,
} from "@plugins/infra/plugins/asset-mirror/core";
import type { AssetPath } from "@plugins/infra/plugins/endpoints/core";
import { WEBSITE_MEDIA_PINS } from "./pins";

/**
 * The site's media, served by the `website-media` mirror
 * (`/api/asset-mirror/website-media/…`): the assets of the `website-media`
 * GitHub release (a pre-release, so it never becomes the repo's Latest), never
 * git. Anyone with write access can replace a release asset, so every file is
 * pinned by sha256 (`./pins.ts`): a replaced or corrupted download is refused,
 * never served. Each render is a new file name (`equin-v<N>.mp4`) — pin it
 * with the asset mirror's `scripts/pin.ts` when it is uploaded.
 */
export const websiteMediaSource = defineAssetMirrorSource({
  id: "website-media",
  remoteBaseUrl:
    "https://github.com/Conchylicultor/equin/releases/download/website-media",
  files: WEBSITE_MEDIA_PINS,
});

type MediaFile = keyof typeof WEBSITE_MEDIA_PINS;
const FILM_FILE: MediaFile = "equin-v22-web.mp4";
/**
 * The poster's file name, exported for the server: the landing page's head
 * preloads it (`showcasePosterPreload`, `server/`), as a URL built from the
 * mirror's route rather than read out of the `AssetPath`.
 */
export const FILM_POSTER_FILE: MediaFile = "equin-v22-web-poster.jpg";

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
  video: assetMirrorFile(websiteMediaSource.id, FILM_FILE),
  poster: assetMirrorFile(websiteMediaSource.id, FILM_POSTER_FILE),
  label: "equin, the showcase film",
};
