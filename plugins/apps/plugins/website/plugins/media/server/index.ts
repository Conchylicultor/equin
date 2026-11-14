import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";
import { websiteMediaSource } from "../core";

export { showcasePosterPreload } from "./internal/poster-preload";

export default {
  description:
    "The website's media (the showcase film and its poster), kept out of git: assets of the website-media GitHub release, pinned by sha256 and served same-origin through the asset mirror and bundled into a release by prewarm. showcasePosterPreload() is the head tag that starts the poster downloading at t0, for the page that shows it.",
  register: [defineAssetMirror(websiteMediaSource)],
} satisfies ServerPluginDefinition;
