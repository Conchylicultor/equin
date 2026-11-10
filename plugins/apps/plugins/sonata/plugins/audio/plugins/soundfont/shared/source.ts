import { defineAssetMirrorSource } from "@plugins/infra/plugins/asset-mirror/core";
import { SOUNDFONT_MIRROR_ID, SOUNDFONT_REMOTE_BASE } from "./mirror";
import { SOUNDFONT_PINS } from "./pins";

/**
 * The gm-soundfont mirror's source: one `<gleitz>-mp3.js` per General MIDI
 * program 1-127, each pinned by sha256 (`./pins.ts`). `web/gm.test.ts` holds
 * the pinned set equal to the GM table's slugs — re-pin with the asset
 * mirror's `scripts/pin.ts` when it changes. Kept apart from `./mirror.ts` so
 * the web voices' bundle never carries the pins.
 */
export const soundfontSource = defineAssetMirrorSource({
  id: SOUNDFONT_MIRROR_ID,
  remoteBaseUrl: SOUNDFONT_REMOTE_BASE,
  files: SOUNDFONT_PINS,
});
