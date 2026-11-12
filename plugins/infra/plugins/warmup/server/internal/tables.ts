import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Which code last re-derived a warm-up's stored state in this database: one row
// per warm-up that declares `derivedFrom`, holding the digest of that code as
// of its last successful run. A boot whose code digests the same has nothing to
// re-derive — every row since was written through the same code — so the drain
// reads one row and skips the warm-up. Per worktree, like the state it covers
// (a fork inherits main's stamps along with main's rows).
export const _warmupCodeStamps = pgTable("warmup_code_stamps", {
  name: text("name").primaryKey(),
  codeDigest: text("code_digest").notNull(),
  derivedAt: timestamp("derived_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
