import { defineAssetMirrorPrewarm } from "@plugins/infra/plugins/asset-mirror/core";
import { soundfontFile } from "../shared/mirror";
import { soundfontSource } from "../shared/source";

/**
 * Prewarm seed for the gm-soundfont mirror.
 *
 * The soundfont contributes the full GM melodic set (programs 1-127) but no
 * instrument is marked `default` — the dedicated sampled piano (program 0) is
 * Sonata's sole default timbre and the fallback for every track with no GM
 * program / override, and all bundled starter songs resolve to program 0. So the
 * soundfont is NOT exercised by the default experience; seeding all 100+ patches
 * would bloat the bundle for timbres a default cold start never touches.
 *
 * We therefore seed exactly ONE representative patch — the soundfont's first
 * contributed melodic timbre, GM program 1 "Bright Acoustic Piano" (id `sf:1`),
 * which is what the soundfont's own fallback chain resolves to. The remaining
 * patches stay lazy/online (downloaded on first play, cached thereafter).
 *
 * `gleitz` slug copied verbatim from this plugin's `web/gm.ts` GM table (the
 * authoritative source — not imported here because gm.ts pulls React icons into
 * what is a build-time-only, browser-free runner). voices.ts forms the URL as
 * `<mirror>/<gleitz>-mp3.js` (`soundfontFile`); mp3 is universal so there is one file per patch
 * (no per-browser format split, unlike the piano's ogg/m4a).
 */
const DEFAULT_GLEITZ = "bright_acoustic_piano";

export default defineAssetMirrorPrewarm({
  source: soundfontSource,
  files: [soundfontFile(DEFAULT_GLEITZ)],
});
