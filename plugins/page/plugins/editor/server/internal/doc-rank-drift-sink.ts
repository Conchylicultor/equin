import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import {
  reconcileDocRanksAtBoot,
  type BootDocRankOutcome,
} from "./doc-rank-boot";

/** A boot reconcile that found drift: the repair it made, for the report. */
export type DocRankDrift = Extract<BootDocRankOutcome, { kind: "drift" }>;

/**
 * Where the boot reconcile announces DRIFT — sidebar order the structural-write
 * chokepoint should already have maintained (see `BootDocRankOutcome`).
 * `reports/page-doc-rank-drift` maps it to a report.
 *
 * A sink, not a direct `recordReport`: this plugin's server barrel is loaded by
 * drizzle-kit through the `_blocks` table it exports (every `page_blocks_ext_*`
 * schema file imports it), and `reports/server` pulls `config_v2`, which throws
 * at module eval in a process with no runtime namespace — the 10 schema files
 * would stop loading. The sink holds what boot emitted until the report plugin
 * registers, then replays it (the `orphanedAttemptSink` precedent).
 */
export const docRankDriftSink = defineReportSink<DocRankDrift>(
  "page/plugins/editor:docRankDriftSink",
);

/**
 * The `onReadyBlocking` step: bring every sidebar group to I-DR, and announce
 * drift. Backfill and clean boots are silent — only drift is a bug.
 */
export async function reconcileDocRanksAndAnnounceDrift(): Promise<void> {
  const outcome = await reconcileDocRanksAtBoot();
  if (outcome.kind === "drift") docRankDriftSink.emit(outcome);
}
