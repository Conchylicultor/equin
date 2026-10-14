import {
  backupSourceWentIn,
  type BackupSourceReport,
  type BackupTargetResult,
} from "@plugins/backup/core";
import type { RunRow } from "@plugins/runs/core";
import { backupRunArm } from "../../core";

/**
 * The backup arm's slice of a merged row, decoded by its own column set
 * (`backupRunArm.read` — the jsonb columns parsed by the arm's schemas).
 *
 * A null value is an answer, not an error: the slice is null on every row of
 * every other kind, and a column is null on a backup that has not got that far
 * yet. The decoders read it as an empty list / no size, which is what "this run
 * has none" looks like too.
 */
const own = (run: RunRow) => backupRunArm.read(run);

/**
 * How many bytes the archive came out to — the one accessor the detail pane's
 * Archive line and the DataView's Archive size column both read, so the two
 * cannot disagree. Null renders as nothing, never `0 B`.
 */
export function backupArchiveSize(run: RunRow): number | null {
  return own(run)?.archiveSize ?? null;
}

/** The run's per-target outcomes. */
export function backupTargetResults(run: RunRow): BackupTargetResult[] {
  return own(run)?.targetResults ?? [];
}

/**
 * The sources that actually went into the archive. Skipped ones are dropped
 * here — the same reading the `sourceCount` column's `WHERE` takes on the
 * server. A FAILED source is kept: it did put something in the archive (or
 * tried to), and this is where a person finds out which source came up short.
 * Both readings come from `backupSourceWentIn`, so neither can drift.
 */
export function backupSources(run: RunRow): BackupSourceReport[] {
  return (own(run)?.sources ?? []).filter(backupSourceWentIn);
}
