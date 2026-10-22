import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { ProducerExecutor } from "@plugins/database/plugins/change-feed/server";
import { getServerGraphHash } from "@plugins/build/plugins/server-build-id/server";
import { setMutedByMetadata } from "@plugins/shell/plugins/notifications/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { _reports } from "@plugins/reports/server";
import { isNoiseReport } from "./noise";
import { reportsProducer } from "./producer";
import { reportIdKind } from "@plugins/reports/core";

// Re-evaluate every report row against the CURRENT noise-rule set and sync both
// the stored `reports.noise` flag and the linked notification's `muted` flag.
//
// `noise` is snapshotted at record time, so a report recorded before a rule
// existed keeps a stale `noise: false` forever — surfacing an un-muted, badge-
// counting notification for what is now known to be benign noise. (This is
// exactly how the resize-observer rule, added 2026-06-07, left May-era
// ResizeObserver crashes un-muted.) Reconciling on boot is the self-healing
// fix: idempotent, runs whenever the rule set may have changed (a deploy), and
// touches only rows whose classification actually flips. After the first
// reconcile a steady-state boot does a single SELECT and zero writes.
export async function backfillNoiseClassification(): Promise<void> {
  const serverGraph = getServerGraphHash();
  const rows = await db
    .select({
      id: _reports.id,
      source: _reports.source,
      message: _reports.message,
      data: _reports.data,
      noise: _reports.noise,
      lastBuildId: _reports.lastBuildId,
    })
    .from(_reports);

  const noiseIds: string[] = [];
  const signalIds: string[] = [];
  for (const row of rows) {
    // Mirror record-report's staleOrigin derivation so a row reclassifies
    // identically to how a fresh occurrence would be classified right now.
    const staleOrigin =
      row.lastBuildId != null &&
      serverGraph != null &&
      row.lastBuildId !== serverGraph;
    // Crash-shaped noise fields live in the kind's generic `data` payload.
    const errorType =
      typeof row.data.errorType === "string" ? row.data.errorType : null;
    const stack = typeof row.data.stack === "string" ? row.data.stack : null;
    const noise = isNoiseReport({
      source: row.source,
      errorType,
      message: row.message,
      stack,
      staleOrigin,
    });
    if (noise !== row.noise) {
      await setReportNoise(db, row.id, noise);
    }
    (noise ? noiseIds : signalIds).push(row.id);
  }
  // Reconcile EVERY linked notification's `muted` to its report row's current
  // noise — not just rows whose flag flipped this boot. A notification can
  // diverge from an unchanged row: pre-dedup, `muted` was snapshotted per
  // occurrence at record time, so a row that was already `noise: true` can still
  // carry earlier occurrences' un-muted notifications (e.g. occurrences recorded
  // while the firing tab's build matched the server's). Notifications link back
  // via metadata.reportId; setMutedByMetadata writes only the rows that actually
  // disagree and pushes only when something changed, so a converged steady state
  // does two indexed scans and zero writes.
  await setMutedByMetadata("reportId", noiseIds, true);
  await setMutedByMetadata("reportId", signalIds, false);
}

/**
 * One reclassification: set `reportId`'s noise flag. One autocommit statement
 * per flip, so the reconcile never holds row locks against a concurrent
 * `recordReport` upsert. Through the producer: a reclassified row changes the
 * Noise column of an open Reports pane (its id routes with the next 2 s
 * flush). Exported for the reports.list oracle, which runs it against a
 * throwaway database.
 */
export async function setReportNoise(
  executor: ProducerExecutor,
  reportId: string,
  noise: boolean,
): Promise<void> {
  await reportsProducer.mutate(
    executor,
    (q, t) =>
      q
        .update(t)
        .set({ noise })
        .where(eq(t.id, reportIdKind.key(reportId))),
    { latency: "background" },
  );
}

// Worktree-scoped boot warm-up: the full `_reports` scan + reconcile is a heavy,
// unbounded read that ran eagerly from `onReady` on EVERY boot in EVERY worktree,
// competing with first requests on the serving-critical path. `_reports` is a
// per-worktree table, so the reconcile must still run on every backend — but
// deferred past serving-ready and throttled by the warmup executor instead. It
// is a pure self-healing OPTIMISATION (reclassifying stale rows against the
// current noise rules); a throw is logged and the drain continues, and steady
// state is a single SELECT + zero writes.
export const backfillNoiseWarmup = defineWarmup({
  name: "reports.backfill-noise",
  description:
    "Reclassifies stored reports against the current noise rules so stale rows stop cluttering the report list.",
  scope: "worktree",
  run: () => backfillNoiseClassification(),
});
