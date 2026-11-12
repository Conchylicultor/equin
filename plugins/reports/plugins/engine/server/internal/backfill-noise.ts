import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { ProducerExecutor } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { setMutedByMetadata } from "@plugins/shell/plugins/notifications/server";
import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { _reports, ReportNoiseRule } from "@plugins/reports/server";
import {
  reportIdKind,
  versionSkewCode,
  versionSkewExplains,
} from "@plugins/reports/core";
import { isNoiseReport } from "./noise";
import { noiseInputCode, noiseInputOf } from "./noise-input";
import { reportsProducer } from "./producer";
import { _reportsReconciled } from "./tables";

// Re-evaluate every report row against the CURRENT noise-rule set and sync both
// the stored `reports.noise` flag and the linked notification's `muted` flag —
// ONCE per change of the rules' code, never on a boot whose rules are the ones
// the rows were last reconciled against.
//
// `noise` is snapshotted at record time, so a report recorded before a rule
// existed keeps a stale `noise: false` forever — surfacing an un-muted, badge-
// counting notification for what is now known to be benign noise. (This is
// exactly how the resize-observer rule, added 2026-06-07, left May-era
// ResizeObserver crashes un-muted.) So the stored classification is stamped
// with the source digest of the code that computed it (`reports_reconciled`):
// every row `recordReport` writes is classified by the running code, so while
// the digest is unchanged there is nothing to redo. It used to re-read and
// re-judge every report on every boot — O(history), main's ~2k rows at ~74
// boots a day, up to 14 s under host load — for a rule set that changes a few
// times a year.
//
// Every input is the row's own: `skewProven` is the fact recorded with the
// occurrences (every one proved version skew), never
// re-derived — the builds retired since would change the answer. (Re-deriving
// the outdated-tab fact against the graph the server serves NOW once marked
// every client report filed before the last deploy as stale, muting real
// crashes after any push.) What the fact EXPLAINS (reports/core's
// versionSkewExplains) is code, and digested like a rule.

/**
 * The classifier's code: every contributed rule's module
 * (`ReportNoiseRuleSpec.code`), `noise-input.ts` (the row → rule-input
 * mapping and how the rules' answers combine) and reports/core's
 * `version-skew.ts` (when a stale tab's report is version skew). Not this
 * module's: it loads the database and both reports barrels, so its digest
 * would move with nearly every push and re-run the pass for nothing.
 */
const noiseRulesCode = defineSourceSet(
  "the report noise classifier's code (the stored `reports.noise` flags)",
);
noiseRulesCode.include(noiseInputCode);
noiseRulesCode.include(versionSkewCode);

const RECONCILE_NAME = "noise";

export async function backfillNoiseClassification(): Promise<void> {
  const rules = ReportNoiseRule.getContributions();
  for (const rule of rules) noiseRulesCode.include(rule.code);
  // The rule ids too: two rules sharing one module are still two rules.
  const digest = `${await sourceDigest([noiseRulesCode])}:${rules
    .map((r) => r.id)
    .sort()
    .join(",")}`;
  const [stamp] = await db
    .select({ codeDigest: _reportsReconciled.codeDigest })
    .from(_reportsReconciled)
    .where(eq(_reportsReconciled.name, RECONCILE_NAME));
  if (stamp?.codeDigest === digest) return;

  await reconcileNoise();

  await db
    .insert(_reportsReconciled)
    .values({ name: RECONCILE_NAME, codeDigest: digest })
    .onConflictDoUpdate({
      target: _reportsReconciled.name,
      set: { codeDigest: digest, reconciledAt: new Date() },
    });
}

/** The O(reports) pass: every row re-judged, every linked notification synced. */
async function reconcileNoise(): Promise<void> {
  const rows = await db
    .select({
      id: _reports.id,
      source: _reports.source,
      noise: _reports.noise,
      skewProven: _reports.skewProven,
    })
    .from(_reports);

  const noiseIds: string[] = [];
  const signalIds: string[] = [];
  for (const row of rows) {
    const noise = isNoiseReport(
      noiseInputOf({ ...row, versionSkew: versionSkewExplains(row) }),
    );
    if (noise !== row.noise) {
      await setReportNoise(db, row.id, noise);
    }
    (noise ? noiseIds : signalIds).push(row.id);
  }
  // Reconcile EVERY linked notification's `muted` to its report row's current
  // noise — not just rows whose flag flipped. A notification can diverge from
  // an unchanged row: pre-dedup, `muted` was snapshotted per occurrence at
  // record time, so a row that was already `noise: true` can still carry
  // earlier occurrences' un-muted notifications. Notifications link back via
  // metadata.reportId; setMutedByMetadata writes only the rows that actually
  // disagree.
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

// Worktree-scoped boot warm-up, deferred past serving-ready and throttled by
// the warmup executor. `_reports` is a per-worktree table, so each backend
// checks its own stamp; a steady-state boot (same rules) is one indexed read.
export const backfillNoiseWarmup = defineWarmup({
  name: "reports.backfill-noise",
  description:
    "Reclassifies stored reports when the noise rules change, so rows recorded before a rule existed stop cluttering the report list.",
  scope: "worktree",
  run: () => backfillNoiseClassification(),
});
