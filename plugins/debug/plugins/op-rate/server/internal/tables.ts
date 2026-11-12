import {
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import { OP_RATE_REGIMES } from "../../core";

// Plain `pgTable`s, not `defineEntity`: these are counters, not domain records.
// Together they are each op's history of calls per monitor window, the baseline
// op-rate judges a window against (see op-rate-baseline.ts).

/**
 * How many monitor windows of one regime landed in each call-count bucket, per
 * op and UTC day. A window in which the op was not called is not stored: it is
 * the day's window count (`op_rate_windows`) minus the op's stored windows.
 * Rows per day are bounded by ops × regimes × buckets an op actually hit, not by
 * traffic.
 */
export const _opRateWindowCounts = pgTable(
  "op_rate_window_counts",
  {
    /** `${kind}:${label}`, the op as the runtime profiler names it. */
    op: text("op").notNull(),
    regime: parsedText("regime", z.enum(OP_RATE_REGIMES)).notNull(),
    dayStart: timestamp("day_start", { withTimezone: true }).notNull(),
    /** Index into BUCKET_UPPER (op-rate-baseline.ts). */
    bucket: smallint("bucket").notNull(),
    windows: integer("windows").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.op, t.regime, t.dayStart, t.bucket] }),
    index("op_rate_window_counts_day_idx").on(t.dayStart),
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
 * boots). An hour the op was not called in is not stored.
 */
export const _opRateHourCalls = pgTable(
  "op_rate_hour_calls",
  {
    /** `${kind}:${label}`, the op as the runtime profiler names it. */
    op: text("op").notNull(),
    hourStart: timestamp("hour_start", { withTimezone: true }).notNull(),
    calls: integer("calls").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.op, t.hourStart] }),
    index("op_rate_hour_calls_hour_idx").on(t.hourStart),
  ],
);
