import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
