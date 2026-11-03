import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { bootSnapshot } from "../core";
import { handleBootSnapshot } from "./internal/handle-boot-snapshot";

export { assembleBootSnapshot } from "./internal/handle-boot-snapshot";
export { preloadedKeys } from "./internal/boot-keys";

export default {
  description:
    "Single-request boot snapshot of all boot-critical resources, hydrated client-side before first paint.",
  loadBearing: false,
  httpRoutes: {
    [bootSnapshot.route]: handleBootSnapshot,
  },
} satisfies ServerPluginDefinition;
