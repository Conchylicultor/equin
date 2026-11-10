import { defineAssetMirrorPrewarm } from "@plugins/infra/plugins/asset-mirror/core";
import { pianoSource } from "../shared/source";

/**
 * Prewarm seed for the splendid-grand-piano mirror — the files the release
 * pipeline bakes into the bundle so the default Acoustic Piano sounds offline on
 * a cold start (before any online warm-up has populated the lazy cache).
 *
 * Every file the mirror pins: each sample smplr's `SplendidGrandPiano` `LAYERS`
 * manifest names, in BOTH formats it negotiates (`.ogg` on Chromium/Firefox,
 * `.m4a` on Safari/WebKit — the Tauri webview), so offline audio works on every
 * release target; the samples are small. `shared/source.test.ts` holds the
 * pinned set equal to `LAYERS`.
 */
export default defineAssetMirrorPrewarm({ source: pianoSource });
