import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import {
  LATENCY_CLIENT_KINDS,
  LATENCY_METRICS,
} from "@plugins/debug/plugins/latency-ledger/core";

/** How far back the scoreboard reads: the latency ledger's minute retention. */
export const SCOREBOARD_DAYS = 35;
const MAX_DAYS = SCOREBOARD_DAYS + 1;
const MAX_WEEKS = 7;

/** What the user feels, in the order the scoreboard shows them. */
export const SCOREBOARD_METRICS = [
  "update-e2e",
  "navigate",
  "input",
  "page-load",
  "thread-lag",
] as const satisfies readonly (typeof LATENCY_METRICS)[number][];
export type ScoreboardMetric = (typeof SCOREBOARD_METRICS)[number];

const StatSchema = z.object({
  count: z.number(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
});
export type ScoreboardStat = z.infer<typeof StatSchema>;

const SeriesSchema = z.object({
  metric: z.enum(SCOREBOARD_METRICS),
  /** Whose samples (latency-ledger's client kinds). */
  audience: z.enum(LATENCY_CLIENT_KINDS),
  days: cappedList(StatSchema.extend({ day: z.string() }), { max: MAX_DAYS }),
  /** Monday-started UTC weeks; the histograms merged, never daily p95s averaged. */
  weeks: cappedList(StatSchema.extend({ week: z.string() }), {
    max: MAX_WEEKS,
  }),
  /** The last 7 whole days, and the 7 before them. */
  last7: StatSchema,
  prev7: StatSchema,
});
export type ScoreboardSeries = z.infer<typeof SeriesSchema>;

const DaySchema = z.object({
  /** `YYYY-MM-DD`, UTC. */
  day: z.string(),
  /** Backend boots that day; null where the boot log no longer reaches. */
  restarts: z.number().nullable(),
  calmMinutes: z.number(),
  pressureMinutes: z.number(),
  sleptMinutes: z.number(),
  /** No host record: the server was down or not writing. */
  unknownMinutes: z.number(),
  /** Report occurrences that day; null before the report history began. */
  reports: z.number().nullable(),
});
export type ScoreboardDay = z.infer<typeof DaySchema>;

const WeekSchema = z.object({
  /** Its Monday, `YYYY-MM-DD`, UTC. */
  week: z.string(),
  /** Days of the week inside the window (the first and current weeks are partial). */
  days: z.number(),
  restarts: z.number().nullable(),
  pressureMinutes: z.number(),
  reports: z.number().nullable(),
  /** Report occurrences per backend boot; null when either is unknown or zero boots. */
  reportsPerRestart: z.number().nullable(),
  /**
   * Fingerprints first seen this week. Null for a week starting before the
   * report history reaches (its count would be an undercount, not a number).
   */
  newCauses: z.number().nullable(),
  /** Fixes recorded on main's fix ledger this week (null: before the history). */
  fixesLanded: z.number().nullable(),
  /**
   * Of the fixes landed this week, how many came back since — their report
   * fired again from code containing the fix (a cohort: it can still grow).
   */
  regressed: z.number().nullable(),
  /** Pushes to main naming a report they fix (`Fixes-report:`), from git. */
  fixPushes: z.number(),
  /** Of those, the ones whose commits also changed a lint rule or a check. */
  guardPushes: z.number(),
});
export type ScoreboardWeek = z.infer<typeof WeekSchema>;

const KindSchema = z.object({
  kind: z.string(),
  total: z.number(),
  /** Occurrences per backend boot over the days both are known. */
  perRestart: z.number().nullable(),
  /** Per week (same order as `weeks`): occurrences per boot. */
  weeks: cappedList(
    z.object({ week: z.string(), perRestart: z.number().nullable() }),
    { max: MAX_WEEKS },
  ),
});
export type ScoreboardKind = z.infer<typeof KindSchema>;

const CountsSchema = z.object({
  landed: z.number().nullable(),
  cameBack: z.number().nullable(),
});

/** Do fixes hold? One report kind's fixes and how many came back, per landing week. */
const FixKindSchema = z.object({
  kind: z.string(),
  /** Over the weeks the history reaches. */
  landed: z.number(),
  cameBack: z.number(),
  weeks: cappedList(CountsSchema.extend({ week: z.string() }), {
    max: MAX_WEEKS,
  }),
});
export type ScoreboardFixKind = z.infer<typeof FixKindSchema>;

/** Report kinds listed, by volume (the rest are summed into the totals only). */
export const SCOREBOARD_KINDS_MAX = 15;

export const ScoreboardSchema = z.object({
  /** The first day of the window. */
  sinceDay: z.string(),
  days: cappedList(DaySchema, { max: MAX_DAYS }),
  weeks: cappedList(WeekSchema, { max: MAX_WEEKS }),
  latency: cappedList(SeriesSchema, {
    max: SCOREBOARD_METRICS.length * LATENCY_CLIENT_KINDS.length,
  }),
  kinds: cappedList(KindSchema, { max: SCOREBOARD_KINDS_MAX }),
  /** Report kinds by fixes landed, most first. */
  fixKinds: cappedList(FixKindSchema, { max: SCOREBOARD_KINDS_MAX }),
  /** The first whole day report volume is known (null: none recorded yet). */
  reportsKnownFrom: z.string().nullable(),
  /** The first day new causes and fix counts are complete (null: none yet). */
  convergenceKnownFrom: z.string().nullable(),
  /** The first instant the boot log covers, when it does not reach the window's start. */
  restartsKnownFrom: z.number().nullable(),
});
export type Scoreboard = z.infer<typeof ScoreboardSchema>;

/**
 * The responsiveness scoreboard: is the app getting faster or slower, and is
 * it converging? Served by the scoreboard's `machine/` half (it reads main's
 * git history for the fix commits), so a host without the computer answers it
 * unavailable. A snapshot: measured when a reader opens it (and by its Refresh)
 * — every input is a day-level trend with no change signal worth following.
 */
export const responsivenessScoreboard = liveValue("stats.scoreboard", {
  schema: ScoreboardSchema,
  load: "snapshot",
  needsMachine: { feature: "Main's git history and boot log" },
});
