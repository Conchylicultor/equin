import { defineAssetMirrorSource } from "@plugins/infra/plugins/asset-mirror/core";
import { PIANO_MIRROR_ID, PIANO_REMOTE_BASE } from "./mirror";
import { PIANO_PINS } from "./pins";

/**
 * The splendid-grand-piano mirror's source: every sample smplr's
 * `SplendidGrandPiano` requests, in both formats it negotiates (`.ogg` on
 * Chromium/Firefox, `.m4a` on Safari/WebKit), each pinned by sha256
 * (`./pins.ts`). `./source.test.ts` holds the pinned set equal to smplr's own
 * `LAYERS` manifest, so a smplr sample-set change fails there — re-pin with
 * the asset mirror's `scripts/pin.ts`. Kept apart from `./mirror.ts` so the
 * web voices' bundle never carries the pins.
 */
export const pianoSource = defineAssetMirrorSource({
  id: PIANO_MIRROR_ID,
  remoteBaseUrl: PIANO_REMOTE_BASE,
  files: PIANO_PINS,
});
