import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runBackgroundNowEndpoint } from "../core";
import { handleRunBackgroundNow } from "./internal/handlers";
import {
  backgroundCatalogServed,
  backgroundRecentRunsServed,
} from "./internal/live";

// What a mechanism uses: `defineBackgroundKind` declares a provider (mount it
// in `register`, call `changed` when its entries move). Consumers read the
// catalog through the core live values; none of them names a provider.
export { defineBackgroundKind } from "./internal/define";
export type { BackgroundKind } from "./internal/define";
export type { BackgroundKindSpec } from "../shared/providers";
export { BackgroundTriggerSource } from "./internal/trigger-source";
export type { BackgroundTriggerSourceSpec } from "./internal/trigger-source";

export default {
  description:
    "Background activity catalog: defineBackgroundKind registers a provider (a mechanism that runs things on its own: jobs, warm-ups, timers) that lists its entries with trigger, scope and latest run, its recent runs and an optional Run now; the catalog merges every provider into the pushed background.catalog value (throttled), serves background.recent-runs per entry and POST /api/background/run-now, fills event-triggered entries' event names from contributed BackgroundTriggerSource annotations, and names no provider.",
  httpRoutes: {
    [runBackgroundNowEndpoint.route]: handleRunBackgroundNow,
  },
  contributions: [
    ...backgroundCatalogServed.declare,
    ...backgroundRecentRunsServed.declare,
  ],
} satisfies ServerPluginDefinition;
