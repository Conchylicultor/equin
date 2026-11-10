import { defineAssetMirrorPrewarm } from "@plugins/infra/plugins/asset-mirror/core";
import { emojibaseSource } from "../shared/source";

/**
 * Prewarm seed for the emojibase mirror: the two files the picker requests
 * (every file the mirror pins), so a release opens the emoji picker offline on
 * a cold start.
 */
export default defineAssetMirrorPrewarm({ source: emojibaseSource });
