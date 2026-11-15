import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import { OP_RATE_REGIMES } from "../../core";

// Plain `pgTable`s, not `defineEntity`: these are counters, not domain records.
// Together they are each op's history of calls per monitor window, the baseline
// op-rate judges a window against (see op-rate-baseline.ts).
//
// One row per op and UTC day, its counters an array: a baseline read touches at
// most ops × days rows, each on its own page. A row per (op, day, bucket) or
// (op, hour) spread one op's week over ~75–170 rows, every one inserted at its
// own moment and so on its own page: a read of 59 ops visited 4,270 heap pages
// for 4,350 rows (2× the table), fast when cached and seconds of random reads
// when the host is under memory pressure.

/**
 * How many monitor windows of one regime landed in each call-count bucket, per
 * op and UTC day: `windows[i]` (1-based in SQL, 0-based in JS) is bucket `i`'s
 * count, the array as long as the highest bucket the op hit that day. A window
 * in which the op was not called is not stored: it is the day's window count
 * (`op_rate_windows`) minus the op's stored windows. Rows per day are bounded by
 * ops × regimes, not by traffic.
 */
export const _opRateDayBuckets = pgTable(
  "op_rate_day_buckets",
  {
    /** `${kind}:${label}`, the op as the runtime profiler names it. */
    op: text("op").notNull(),
    regime: parsedText("regime", z.enum(OP_RATE_REGIMES)).notNull(),
    dayStart: timestamp("day_start", { withTimezone: true }).notNull(),
    /** Windows per bucket; index into BUCKET_UPPER (op-rate-baseline.ts). */
    windows: integer("windows").array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.op, t.regime, t.dayStart] }),
    index("op_rate_day_buckets_day_idx").on(t.dayStart),
  ],
);

/**
 * How many monitor windows of each regime this backend judged per UTC hour: a
 * day's windows are the sum of its hours, and an hour with too few windows (the
 * backend was down) is no sample of a usual hour.
 */
export const _opRateWindows = pgTable(
  "op_rate_windows",
  {
    regime: parsedText("regime", z.enum(OP_RATE_REGIMES)).notNull(),
    hourStart: timestamp("hour_start", { withTimezone: true }).notNull(),
    windows: integer("windows").notNull(),
  },
  (t) => [primaryKey({ columns: [t.regime, t.hourStart] })],
);

/**
 * Each op's calls per UTC hour, every window of the hour summed (boot and
 * steady alike — main restarts within most hours, so a usual hour holds its
 * boots), per op and UTC day: `calls[h]` (1-based in SQL, 0-based in JS) is hour
 * `h` of the day, the array as long as the day's last hour the op was called in.
 */
export const _opRateDayHours = pgTable(
  "op_rate_day_hours",
  {
    /** `${kind}:${label}`, the op as the runtime profiler names it. */
    op: text("op").notNull(),
    dayStart: timestamp("day_start", { withTimezone: true }).notNull(),
    calls: integer("calls").array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.op, t.dayStart] }),
    index("op_rate_day_hours_day_idx").on(t.dayStart),
  ],
);
