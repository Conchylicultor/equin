import { z } from "zod";

// The jsonb payload for a `report-storm` report: one report kind's collapse
// accounting for one storm, filed by the reports engine when a kind blows past
// its per-window distinct-fingerprint ceiling (see
// plugins/reports/plugins/engine/server/internal/fan-out.ts). Structurally the engine's
// StormSummary (it files `data: { ...summary }` verbatim — the server kind file
// carries a compile-time drift guard against the reports type). One report per
// (collapsed kind, window): the fingerprint keys on both, so a ten-minute stall
// yields ten rows, each naming its own roster, instead of one row that keeps
// absorbing.
export const ReportStormPayloadSchema = z.object({
  // The report kind whose alerts were collapsed ("slow-op", "crash", …) —
  // open by construction, any kind can storm.
  collapsedKind: z.string(),
  // The window the collapsing started in, and the instant the rollup closed
  // (both epoch ms). Their gap is how long the burst ran.
  windowStartedAt: z.number(),
  windowEndedAt: z.number(),
  // The ceiling in force: distinct fingerprints of this kind that were allowed
  // their own alert this window before collapsing started.
  budget: z.number(),
  // Distinct fingerprints that were collapsed, and the total occurrences they
  // account for. `occurrences` is always exact; `distinctFingerprints`
  // saturates in the pathological case of a single window producing more than
  // 100k distinct keys, where it becomes a floor.
  distinctFingerprints: z.number(),
  occurrences: z.number(),
  // The collapsed fingerprints named inline, loudest first, capped by the
  // `reports.stormRosterMax` config.
  roster: z.array(
    z.object({
      fingerprint: z.string(),
      message: z.string(),
      count: z.number(),
    }),
  ),
  // Distinct collapsed fingerprints the roster had no room to name. The key is
  // gone from the rollup; the count survives, mirroring how the duress shed
  // buffer keeps a `dropped` count when the item itself is gone.
  rosterTruncated: z.number(),
});
export type ReportStormPayload = z.infer<typeof ReportStormPayloadSchema>;
