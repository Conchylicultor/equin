import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { bootSnapshot } from "../core";
import { handleBootSnapshot } from "./internal/handle-boot-snapshot";
import { bootSnapshotHead } from "./internal/head-request";

export { assembleBootSnapshot } from "./internal/handle-boot-snapshot";
export { preloadedKeys } from "./internal/boot-keys";

export default {
  description:
    "Single-request boot snapshot of all boot-critical resources, hydrated client-side before first paint. The SPA shell's head starts the request (DocumentHead.Fragment), so it runs in parallel with the module downloads rather than after the eager tier.",
  loadBearing: false,
  httpRoutes: {
    [bootSnapshot.route]: handleBootSnapshot,
  },
  contributions: [bootSnapshotHead],
} satisfies ServerPluginDefinition;
