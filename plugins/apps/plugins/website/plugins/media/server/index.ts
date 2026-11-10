import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";
import { websiteMediaSource } from "../core";

export default {
  description:
    "The website's media (the showcase film and its poster), kept out of git: assets of the website-media GitHub release, pinned by sha256 and served same-origin through the asset mirror and bundled into a release by prewarm.",
  register: [defineAssetMirror(websiteMediaSource)],
} satisfies ServerPluginDefinition;
