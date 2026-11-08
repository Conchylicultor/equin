import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { idRef } from "@plugins/ids/server";
import { reportIdKind } from "@plugins/reports/core";
import { _reports } from "@plugins/reports/server";

// Which code the stored classification of `reports` was last reconciled
// against: one row per reconcile (`name`), holding the source digest of the
// code that computed it. A boot whose code digests the same has nothing to
// reconcile — every row since was written by `recordReport` under that same
// code — so it reads one row and stops; only a change of the code re-runs the
// O(reports) pass. Per worktree, like `reports` itself.
export const _reportsReconciled = pgTable("reports_reconciled", {
  name: text("name").primaryKey(),
  codeDigest: text("code_digest").notNull(),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// The fix ledger: one row per fix of a report — a push to main whose commits
// name it (`Fixes-report: <id>`, written by `./equin push --fixes-report`),
// keyed by the newest of those commits — or an earlier commit a later push
// claims fixed it (`Report-fixed-by: <id>@<sha>`, `--report-fixed-by`), keyed
// by that commit. Every column is a fact, stamped once: when the claim reached
// main, when main first ran code containing it, and
// the first occurrence from code containing it (its commit; null when that
// code could not name one). A report's `fix_state` is derived from its newest
// row (`fix-ledger.ts`), so fixing a report again starts a new row and the
// history stays. Main's only: it is main's history it records.
export const _reportFixes = pgTable(
  "report_fixes",
  {
    // A report deleted by retention takes its fixes with it.
    reportId: idRef(reportIdKind, "report_id", () => _reports.id, {
      onDelete: "cascade",
    }).notNull(),
    commit: text("commit").notNull(),
    landedAt: timestamp("landed_at", { withTimezone: true }).notNull(),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    regressedAt: timestamp("regressed_at", { withTimezone: true }),
    regressedCommit: text("regressed_commit"),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.commit] }),
    index("report_fixes_landed_idx").on(t.landedAt),
  ],
);
