import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";
import { SOUNDFONT_MIRROR_ID, SOUNDFONT_REMOTE_BASE } from "../shared/mirror";

/**
 * Registers the General MIDI soundfont asset mirror so the web voices can fetch
 * each instrument's samples from `/api/asset-mirror/gm-soundfont/…` (same-origin,
 * cached to `~/.equin/cache/asset-mirror/`) instead of the remote gleitz CDN. After one online
 * warm-up per instrument, that timbre sounds fully offline.
 */
export default {
  description:
    "Registers the gm-soundfont asset mirror so the General MIDI instruments' samples are served same-origin (offline-capable) rather than streamed from the remote gleitz CDN.",
  register: [
    defineAssetMirror({
      id: SOUNDFONT_MIRROR_ID,
      remoteBaseUrl: SOUNDFONT_REMOTE_BASE,
    }),
  ],
} satisfies ServerPluginDefinition;
