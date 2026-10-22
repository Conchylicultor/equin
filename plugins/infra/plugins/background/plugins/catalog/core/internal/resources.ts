import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BackgroundEntrySchema, BackgroundRecentRunsSchema } from "./entry";

/**
 * Everything this backend runs on its own, merged from every registered
 * provider. External and bounded by the declared set (the providers hold it).
 * Pushed when a provider reports a change (a run started or finished),
 * throttled server-side so per-minute work cannot churn it.
 */
export const backgroundCatalog = liveValue("background.catalog", {
  schema: z.array(BackgroundEntrySchema),
});

/**
 * One entry's recent runs, newest first — at most `RECENT_RUNS_MAX`. Pushed by
 * the same provider change signal as the catalog, per entry.
 */
export const backgroundRecentRuns = liveValue("background.recent-runs", {
  schema: BackgroundRecentRunsSchema,
  params: ["kind", "name"],
});

/**
 * The same catalog for the machine-wide central runtime (one process every
 * worktree shares): what IT runs on its own. Separate from `backgroundCatalog`
 * because it is served by a different process — each half loads, and fails,
 * on its own. Every entry's `scope` is `central`.
 */
export const backgroundCentralCatalog = liveValue(
  "background.central-catalog",
  {
    schema: z.array(BackgroundEntrySchema),
    origin: "central",
    // The central runtime is the computer's machine-wide process.
    needsMachine: { feature: "Reading the central runtime's activity" },
  },
);

/** One central entry's recent runs — `backgroundRecentRuns`, served by central. */
export const backgroundCentralRecentRuns = liveValue(
  "background.central-recent-runs",
  {
    schema: BackgroundRecentRunsSchema,
    params: ["kind", "name"],
    origin: "central",
    needsMachine: { feature: "Reading the central runtime's activity" },
  },
);

/**
 * Start one entry now, in this backend. Refused (409) for an entry whose
 * provider does not offer it (`canRunNow: false`), 404 for an unknown entry.
 * Returns what the provider started (a job id).
 */
export const runBackgroundNowEndpoint = defineEndpoint({
  route: "POST /api/background/run-now",
  body: z.object({ kind: z.string(), name: z.string() }),
  response: z.object({ ref: z.string() }),
});
