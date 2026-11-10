import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";
import { pianoSource } from "../shared/source";

/**
 * Registers the splendid-grand-piano asset mirror so the web voices can fetch
 * samples from `/api/asset-mirror/splendid-grand-piano/…` (same-origin, cached
 * to `~/.equin/cache/asset-mirror/`) instead of the remote CDN. After one online warm-up the
 * piano sounds fully offline.
 */
export default {
  description:
    "Registers the splendid-grand-piano asset mirror so the acoustic piano's samples are served same-origin (offline-capable) rather than streamed from the remote CDN.",
  register: [defineAssetMirror(pianoSource)],
} satisfies ServerPluginDefinition;
