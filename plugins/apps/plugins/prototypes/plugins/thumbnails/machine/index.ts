import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { onDepInstallSettled } from "@plugins/infra/plugins/deps/server";
import { FileRootLocation } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import { thumbnailCacheDir } from "../data-dirs";
import { ThumbnailRenderer } from "../server/internal/renderer";
import { thumbnailCache } from "../server/internal/roots";
import { syncThumbnails } from "../server/internal/sync";
import { renderThumbnailJob, sweepThumbnailsJob } from "./internal/jobs";
import { chromiumThumbnails } from "./internal/renderer";

export default {
  description:
    "Prototype thumbnails, desktop half: provides the ThumbnailRenderer host service as headless Chromium (the serial prototypes.render-thumbnail job, Chromium read from infra/deps and requested when missing, re-synced when its install settles), binds the thumbnail cache root to the host-global cache data dir, and sweeps it nightly.",
  contributions: [
    ThumbnailRenderer.provide(chromiumThumbnails),
    FileRootLocation(thumbnailCache, thumbnailCacheDir),
  ],
  register: [renderThumbnailJob, sweepThumbnailsJob],
  onReady: () => {
    // A render that found no browser parked its card in `waiting-for-browser`
    // and asked for the install; when that install settles, re-sync, which
    // re-renders those (or leaves them to fail honestly if it failed).
    onDepInstallSettled(chromium, () => {
      void runTracked("prototype-thumbnails:sync", () => syncThumbnails());
    });
  },
} satisfies MachinePluginDefinition;
