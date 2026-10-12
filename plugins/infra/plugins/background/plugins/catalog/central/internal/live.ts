import { serveValue } from "@plugins/network/plugins/live/central";
import {
  backgroundCentralCatalog,
  backgroundCentralRecentRuns,
  type BackgroundEntry,
} from "../../core";
import {
  CATALOG_THROTTLE_MS,
  RECENT_RUNS_THROTTLE_MS,
  loadCatalog,
  loadRecentRuns,
} from "../../shared/load";

// Central is ONE process for the whole machine, so everything it lists runs
// machine-wide. A provider that claimed another scope here would put a wrong
// "Where" on the page — refuse it loudly instead.
function assertCentral(entry: BackgroundEntry): BackgroundEntry {
  if (entry.scope !== "central") {
    throw new Error(
      `[background] central provider "${entry.kind}" listed "${entry.name}" with scope "${entry.scope}" — every central entry runs machine-wide (scope "central")`,
    );
  }
  return entry;
}

/** The central half of the catalog, pushed on its providers' `changed`. */
export const backgroundCentralCatalogServed = serveValue(
  backgroundCentralCatalog,
  {
    source: "external",
    changes: "notified",
    loader: () => loadCatalog(assertCentral),
    throttleMs: CATALOG_THROTTLE_MS,
  },
);

/** One central entry's recent runs. */
export const backgroundCentralRecentRunsServed = serveValue(
  backgroundCentralRecentRuns,
  {
    source: "external",
    changes: "notified",
    loader: loadRecentRuns,
    throttleMs: RECENT_RUNS_THROTTLE_MS,
  },
);
