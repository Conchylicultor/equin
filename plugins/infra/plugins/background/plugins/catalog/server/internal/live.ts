import { serveValue } from "@plugins/network/plugins/live/server";
import { backgroundCatalog, backgroundRecentRuns } from "../../core";
import {
  CATALOG_THROTTLE_MS,
  RECENT_RUNS_THROTTLE_MS,
  loadCatalog,
  loadRecentRuns,
} from "../../shared/load";
import { BackgroundTriggerSource, annotateTrigger } from "./trigger-source";

/**
 * The catalog, pushed. External: the truth is each provider's declarations and
 * its run records; providers say when it moved (`BackgroundKind.changed`).
 * Bounded by the declared set, which the process holds.
 */
export const backgroundCatalogServed = serveValue(backgroundCatalog, {
  source: "external",
  changes: "notified",
  loader: () => {
    const sources = BackgroundTriggerSource.getContributions();
    return loadCatalog((e) => annotateTrigger(e, sources));
  },
  throttleMs: CATALOG_THROTTLE_MS,
});

/** One entry's recent runs, pushed on its provider's change signal. */
export const backgroundRecentRunsServed = serveValue(backgroundRecentRuns, {
  source: "external",
  changes: "notified",
  loader: loadRecentRuns,
  throttleMs: RECENT_RUNS_THROTTLE_MS,
});
