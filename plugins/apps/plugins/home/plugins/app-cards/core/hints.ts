import { defineHintAnchor } from "@plugins/hints/core";

/** Home's app gallery — the whole grid of installed apps. */
export const homeGalleryAnchor = defineHintAnchor("home.gallery");

/** One app's tile in Home's gallery, by app id (`agent-manager`, …). */
export const appTileAnchor = defineHintAnchor(
  "home.app-tile",
  (appId: string) => appId,
);
