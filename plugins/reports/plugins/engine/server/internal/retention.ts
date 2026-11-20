import { sql } from "drizzle-orm";
import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _reports } from "@plugins/reports/server";
import {
  _reportFingerprintsSeen,
  _reportFixDays,
  _reportTrendDays,
} from "./tables";

// `_reports` is an unbounded-growth firehose: automatic crash / slow-op /
// render-loop / endpoint-error telemetry is deduped per (fingerprint, worktree)
// but the DISTINCT-fingerprint set grows without bound and has never had a
// retention bound. A 7-day nightly TTL sweep matches the debug.trace-cleanup
// precedent for diagnostic telemetry: reports are crash/diagnostic records,
// re-filed automatically if the underlying problem recurs.
//
// This `defineRetention` call IS `_reports`'s growth bound — there is no separate
// "firehose" declaration to make. The bound is recorded in the growth-bound
// registry only when `reportsRetention` is mounted in `register: [...]` (see
// `plugins/reports/plugins/engine/server/index.ts`), so a defined-but-unmounted policy records
// nothing rather than lying about coverage.
//
// `perWorktree: true`: `_reports` lives in the per-worktree DB fork, so the
// sweep must run in every worktree backend (each over its own rows).
//
// `where: isNull(_reports.taskId)` — SAFETY SCOPE. A report's `taskId` is null
// until a human explicitly clicks "investigate", which creates a linked
// investigation task and stamps `taskId` (see investigate.ts). That link is the
// idempotency key: re-investigating the same report returns the existing live
// task via `existingTaskId`. Deleting a report row with a non-null `taskId`
// would sever that link, so a recurrence would file a DUPLICATE investigation
// task even while the original is still open. We cannot cheaply/ cleanly join to
// the tasks table to test whether the linked task is closed (cross-plugin
// boundary; tasks tables are plugin-private), so we take the conservative,
// purely-local predicate: only sweep reports with NO linked investigation
// (`taskId IS NULL`). This still bounds the firehose — all automatic telemetry
// starts and stays `taskId null` — while the small, human-curated investigated
// subset is retained.
//
// `fix_state` — the FIX LEDGER's scope. A report a commit claims fixed is what
// the fix ledger (`report_fixes`, which cascades away with its report) judges
// on: Landed → Fixed once deployed → Regressed by a later occurrence of the
// SAME row. Swept on the createdAt clock, a report filed 7 days before its fix
// landed vanished hours after the fix (2026-11-20: three fixed reports swept at
// 04:00 the night after their fixes landed) — taking its ledger rows with it, so
// a recurrence opened a fresh row the fix knew nothing about (no Regressed), and
// every advance of main re-read the still-in-window claim against a report
// main no longer held (UnknownFixedReport, ~1/min). So a report whose fix state
// moved off `open` is kept for `FIXED_REPORT_KEEP_DAYS` after its last
// change of fix state (landed / deployed / regressed) — long enough to see a
// fix hold or come back — and swept by the same nightly job afterwards. Still
// bounded: every row ages out on one of the two clocks.
const FIXED_REPORT_KEEP_DAYS = 30;

export const reportsRetention = defineRetention({
  table: _reports,
  column: "createdAt",
  ttlDays: 7,
  perWorktree: true,
  where: sql`${_reports.taskId} IS NULL AND (${_reports.fixState} = 'open' OR ${_reports.fixStateAt} < now() - make_interval(days => ${FIXED_REPORT_KEEP_DAYS}))`,
});

// The report history (./tables.ts) outlives the reports by design: a year and
// more, so a trend can be read long after the rows it counted were swept. The
// seen set's bound is the same: a cause unseen for 400 days counts as new again.
export const trendRetentions = [
  defineRetention({
    table: _reportTrendDays,
    column: "day",
    ttlDays: 400,
    perWorktree: true,
  }),
  defineRetention({
    table: _reportFixDays,
    column: "day",
    ttlDays: 400,
    perWorktree: true,
  }),
  defineRetention({
    table: _reportFingerprintsSeen,
    column: "firstSeenAt",
    ttlDays: 400,
    perWorktree: true,
  }),
];
