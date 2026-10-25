import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { onPrototypesChanged } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { onDepInstallSettled } from "@plugins/infra/plugins/deps/server";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import { renderThumbnailJob, sweepThumbnailsJob } from "./internal/jobs";
import { prototypeThumbnailsServed } from "./internal/state";
import { syncChangedThumbnails, syncThumbnails } from "./internal/sync";

export default {
  description:
    "Rendered PNG previews for the prototypes gallery: a content-addressed disk cache, a headless-chromium render job driven by the files watcher, and the push state resource the cards read; the immutable serving route is the machine/ half's.",
  contributions: [...prototypeThumbnailsServed.declare],
  register: [renderThumbnailJob, sweepThumbnailsJob],
  onReady: () => {
    // `files` owns `prototypes/` and already watches it; subscribing to the
    // signal it computes is what keeps a second watcher off the same tree.
    // It names the prototypes that moved, so an edit re-decides those alone.
    onPrototypesChanged((changed) => {
      void runTracked("prototype-thumbnails:sync-changed", () =>
        syncChangedThumbnails(changed),
      );
    });

    // A render that found no browser parked its card in `waiting-for-browser`
    // and asked for the install; when that install settles, re-sync, which
    // re-renders those (or leaves them to fail honestly if it failed).
    onDepInstallSettled(chromium, () => {
      void runTracked("prototype-thumbnails:sync", () => syncThumbnails());
    });

    // Reconcile once at boot: the cache is host-global and survives restarts,
    // so this is usually a few stats that confirm everything is already there.
    // Fire-and-forget — a failure surfaces as an unhandled rejection (reports
    // files it) rather than being swallowed into an invisible boot no-op.
    void runTracked("prototype-thumbnails:sync", () => syncThumbnails());
  },
} satisfies ServerPluginDefinition;
