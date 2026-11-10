import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";
import { emojibaseSource } from "../shared/source";

export default {
  description:
    "Registers the emojibase data mirror so the emoji picker's data is served same-origin (offline-capable after one warm-up) rather than fetched from the CDN by the browser.",
  register: [defineAssetMirror(emojibaseSource)],
} satisfies ServerPluginDefinition;
