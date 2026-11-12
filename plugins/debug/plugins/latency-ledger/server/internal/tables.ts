import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { LATENCY_METRICS } from "../../core";

// Plain `pgTable`s, not `defineEntity`: nothing here is a domain record with a
// field schema or a wire shape — they are counters.

/**
 * One metric's samples for one minute, as a histogram (see core/histogram.ts).
 * The browser's minutes and the server's merge into the same row by adding the
 * arrays, so a row is at most one per (metric, minute): ≤ 5 × 1,440 a day however
 * busy the app is. Any window's p50/p95 is a merge of its rows.
 */
export const _latencyLedgerMinute = pgTable(
  "latency_ledger_minute",
  {
    metric: parsedText("metric", z.enum(LATENCY_METRICS)).notNull(),
    minuteStart: timestamp("minute_start", { withTimezone: true }).notNull(),
    /** HISTOGRAM_SCHEME the array is aligned to; the query ignores other schemes. */
    scheme: smallint("scheme").notNull(),
    counts: integer("counts").array().notNull(),
    count: integer("count").notNull().default(0),
    sumMs: doublePrecision("sum_ms").notNull().default(0),
    maxMs: doublePrecision("max_ms").notNull().default(0),
    censored: integer("censored").notNull().default(0),
    excluded: integer("excluded").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.metric, t.minuteStart] }),
    index("latency_ledger_minute_start_idx").on(t.minuteStart),
  ],
);

/**
 * What the machine was like in one minute. Raw values, not a verdict: whether a
 * minute counts as "under pressure" is decided when reading (`minuteClass` in query.ts)
 * so the bar can be re-cut without rewriting history. The memory columns are null
 * on a backend that is not main — only main samples the host.
 */
export const _latencyLedgerHostMinute = pgTable("latency_ledger_host_minute", {
  minuteStart: timestamp("minute_start", { withTimezone: true }).primaryKey(),
  duress: boolean("duress").notNull().default(false),
  maxDecompressionsPerSec: doublePrecision("max_decompressions_per_sec"),
  minFreeMemMb: doublePrecision("min_free_mem_mb"),
  maxLoad1: doublePrecision("max_load1"),
  /** Milliseconds the machine was asleep in this minute. Any > 0 excludes it. */
  sleptMs: doublePrecision("slept_ms").notNull().default(0),
});

/**
 * Where the serving thread's time went in one minute: stack samples by the plugin
 * whose code was running. The sampler only samples a busy thread, so
 * `samples × periodMs` is time ON the thread, not wall time of overlapping work.
 */
export const _latencyLedgerThreadMinute = pgTable(
  "latency_ledger_thread_minute",
  {
    minuteStart: timestamp("minute_start", { withTimezone: true }).primaryKey(),
    samples: integer("samples").notNull(),
    /** Median gap between consecutive samples — the sampler's period this minute. */
    periodMs: doublePrecision("period_ms"),
    /** Top owners → sample count; the rest summed under "other". */
    owners: parsedJson("owners", z.record(z.string(), z.number())).notNull(),
  },
);

/** Page loads and navigations, raw: few enough, and the route is the point. */
export const _latencyLedgerInteraction = pgTable(
  "latency_ledger_interaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    kind: parsedText("kind", z.enum(["page-load", "navigate"])).notNull(),
    route: text("route").notNull(),
    durationMs: doublePrecision("duration_ms").notNull(),
    hidden: boolean("hidden").notNull(),
    censored: boolean("censored").notNull(),
    resourceCount: integer("resource_count").notNull(),
    lastResourceKey: text("last_resource_key"),
    /**
     * The browser tab it happened in (session-scoped: the same across the
     * tab's reloads). Null for a row from a bundle that predates the field —
     * a client unknown, never guessed.
     */
    clientId: text("client_id"),
    /** The tab was driven by automation (`navigator.webdriver`). A mark only. */
    automated: boolean("automated").notNull().default(false),
  },
  (t) => [
    index("latency_ledger_interaction_at_idx").on(t.occurredAt),
    // One client's interactions in a window (client-rate's routes of a trip).
    index("latency_ledger_interaction_client_idx").on(t.clientId, t.occurredAt),
  ],
);
