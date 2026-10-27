import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ThumbnailRenderer } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/server";

export default {
  description:
    "The prototype thumbnails of a host without a browser to render with: provides the ThumbnailRenderer host service as unavailable, so a cache miss is the card's muted 'Preview unavailable' marker and the only previews are the PNGs a seed put in the cache (the browser composition). Never booted by the desktop.",
  portable: true,
  contributions: [
    ThumbnailRenderer.provide({
      kind: "unavailable",
      message:
        "Previews are rendered by a headless browser on the computer, which this host does not have.",
    }),
  ],
} satisfies ServerPluginDefinition;
