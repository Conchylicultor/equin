import { defineAssetMirrorSource } from "@plugins/infra/plugins/asset-mirror/core";
import { EMOJIBASE_MIRROR_ID } from "./mirror";
import { EMOJIBASE_PINS } from "./pins";

/**
 * The emojibase mirror's source: the emojibase-data release the picker reads,
 * pinned so the mirrored files (cached once per machine, served immutable)
 * never change under a version bump nobody reviewed, and each file's bytes by
 * sha256 (`./pins.ts`). frimousse fetches `<base>/<locale>/data.json` and
 * `<base>/<locale>/messages.json` — the two files pinned for `en`. Kept apart
 * from `./mirror.ts` so the picker's bundle never carries the pins.
 */
export const emojibaseSource = defineAssetMirrorSource({
  id: EMOJIBASE_MIRROR_ID,
  remoteBaseUrl: "https://cdn.jsdelivr.net/npm/emojibase-data@17.0.0",
  files: EMOJIBASE_PINS,
});
