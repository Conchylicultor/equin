import {
  boolean,
  date,
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
import {
  CLIENT_METRICS,
  LATENCY_CLIENT_KINDS,
  LATENCY_METRICS,
} from "../../core";

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
 * The browser's minutes again, split by whose tab they came from: a person's
 * (`real`) or one driven by automation (`automated`: the agent browser, an e2e
 * run). Written in the same statement as the combined row above (./store.ts),
 * which stays every tab's — so the summary and every reader of the combined
 * table are unchanged, and "every tab" reads continuously across the split
 * (2026-11-19). A batch from a bundle that sends no client lands in the
 * combined row only. Browser metrics only (`CLIENT_METRICS`).
 */
export const _latencyLedgerClientMinute = pgTable(
  "latency_ledger_client_minute",
  {
    metric: parsedText("metric", z.enum(CLIENT_METRICS)).notNull(),
    minuteStart: timestamp("minute_start", { withTimezone: true }).notNull(),
    clientKind: parsedText(
      "client_kind",
      z.enum(["real", "automated"]),
    ).notNull(),
    scheme: smallint("scheme").notNull(),
    counts: integer("counts").array().notNull(),
    count: integer("count").notNull().default(0),
    sumMs: doublePrecision("sum_ms").notNull().default(0),
    maxMs: doublePrecision("max_ms").notNull().default(0),
    censored: integer("censored").notNull().default(0),
    excluded: integer("excluded").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.metric, t.minuteStart, t.clientKind] }),
    index("latency_ledger_client_minute_start_idx").on(t.minuteStart),
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
    /** The route pattern (older rows: the raw path, which was its own place). */
    route: text("route").notNull(),
    /** Hash of the exact path within the pattern; null on a row that predates it. */
    placeKey: text("place_key"),
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

const MinuteClassSchema = z.enum(["calm", "pressure", "unknown", "slept"]);

/**
 * One closed UTC day of one metric, client kind and minute class: the minute
 * rows added together, written ONCE by the hourly `latency-ledger.roll-days`
 * job when the day can no longer change (./daily.ts) — so a 30-day trend reads
 * a few hundred rows instead of summing ~150k minute histograms (3.5 s on main,
 * 2026-11-19), and outlives the minute table's 35-day TTL. The class is the
 * minute's (`minuteClass` in query.ts), decided when the day is rolled.
 */
export const _latencyLedgerDay = pgTable(
  "latency_ledger_day",
  {
    day: date("day", { mode: "string" }).notNull(),
    metric: parsedText("metric", z.enum(LATENCY_METRICS)).notNull(),
    clientKind: parsedText(
      "client_kind",
      z.enum(LATENCY_CLIENT_KINDS),
    ).notNull(),
    minuteClass: parsedText("minute_class", MinuteClassSchema).notNull(),
    scheme: smallint("scheme").notNull(),
    counts: integer("counts").array().notNull(),
    count: integer("count").notNull(),
    maxMs: doublePrecision("max_ms").notNull(),
    censored: integer("censored").notNull(),
    excluded: integer("excluded").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.day, t.metric, t.clientKind, t.minuteClass],
    }),
  ],
);

/**
 * One closed UTC day of the machine: its minutes by class. Written in the same
 * transaction as the day's `latency_ledger_day` rows, so its presence is the
 * mark that the day is rolled (a day with no samples still gets this row).
 */
export const _latencyLedgerHostDay = pgTable("latency_ledger_host_day", {
  day: date("day", { mode: "string" }).primaryKey(),
  calmMinutes: integer("calm_minutes").notNull(),
  pressureMinutes: integer("pressure_minutes").notNull(),
  sleptMinutes: integer("slept_minutes").notNull(),
  /** Minutes with no host record: the server was down or not writing yet. */
  unknownMinutes: integer("unknown_minutes").notNull(),
  rolledAt: timestamp("rolled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
