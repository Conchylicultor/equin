import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";
import { WEBSITE_MEDIA_MIRROR_ID, WEBSITE_MEDIA_REMOTE_BASE } from "../core";

export default {
  description:
    "The website's media (the showcase film and its poster), kept out of git: assets of the website-media GitHub release, served same-origin through the asset mirror and bundled into a release by prewarm.",
  register: [
    defineAssetMirror({
      id: WEBSITE_MEDIA_MIRROR_ID,
      remoteBaseUrl: WEBSITE_MEDIA_REMOTE_BASE,
    }),
  ],
} satisfies ServerPluginDefinition;
