import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { parsedText } from "@plugins/database/plugins/sql-column/server";

/** What upstream answered, the last time it could be asked. */
export const RELEASE_CHECK_OUTCOMES = [
  "no-upstream",
  "no-release",
  "release",
] as const;

/**
 * The last answer upstream gave about its releases: ONE row (keyed by
 * `singleton`, which can only be true), written by the daily `upstream.detect-updates` job and by
 * `POST /api/upstream/check`, read by the `upstream.release-status` value.
 *
 * Only what needs the NETWORK is stored — upstream's newest release tag and
 * when it was read. Where local `main` stands against it (current / behind,
 * and the release `main` is on) is re-derived from git on every read, so a
 * merge that lands the release reads as current at once, not after the next
 * daily check. An unreachable upstream writes nothing: it said nothing.
 */
export const _upstreamReleaseCheck = pgTable(
  "upstream_release_check",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    outcome: parsedText("outcome", z.enum(RELEASE_CHECK_OUTCOMES)).notNull(),
    /** The upstream remote that answered; null exactly when `outcome` is `no-upstream`. */
    remote: text("remote"),
    /** Upstream's newest release tag; set exactly when `outcome` is `release`. */
    latest: text("latest"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("upstream_release_check_one_row", sql`${t.singleton}`)],
);
