import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { onPrototypesChanged } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { getPrototypeThumbnail } from "../core";
import { handleThumbnail } from "./internal/serve-thumbnail";
import { prototypeThumbnailsServed } from "./internal/state";
import { syncChangedThumbnails, thumbnailsSyncWarmup } from "./internal/sync";

// The renderer is the one thing a host brings: Chromium on the desktop (this
// plugin's machine/ half), none in a browser host (`thumbnails/no-renderer`).
export { ThumbnailRenderer } from "./internal/renderer";
// The cache's file root — for a seed whose PNGs were rendered ahead of time (a
// browser host renders none): written there, they answer as any cache hit.
export { thumbnailCache } from "./internal/roots";

export default {
  description:
    "Rendered PNG previews for the prototypes gallery, on every host: the content-addressed cache (the thumbnailCache file root), the fingerprint sync driven by the files watcher, the push state resource the cards read and the immutable serving route. Rendering is the ThumbnailRenderer host service's — a host without one answers a cache miss as `unavailable`.",
  portable: true,
  httpRoutes: {
    [getPrototypeThumbnail.route]: rawEndpointHandler(
      getPrototypeThumbnail,
      handleThumbnail,
    ),
  },
  contributions: [...prototypeThumbnailsServed.declare],
  // Reconciles once per boot, after the host settles: the cache survives
  // restarts on the desktop (and is seeded in a browser host), so this
  // usually confirms everything is already there.
  register: [thumbnailsSyncWarmup],
  onReady: () => {
    // `files` owns `prototypes/` and already watches it; subscribing to the
    // signal it computes is what keeps a second watcher off the same tree.
    // It names the prototypes that moved, so an edit re-decides those alone.
    onPrototypesChanged((changed) => {
      void runTracked("prototype-thumbnails:sync-changed", () =>
        syncChangedThumbnails(changed),
      );
    });
  },
} satisfies ServerPluginDefinition;
