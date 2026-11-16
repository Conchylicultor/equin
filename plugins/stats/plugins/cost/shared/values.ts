import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  cappedList,
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

// The Stats → Cost reads. INTERIM: metrics P2 (research/2026-09-30-global-
// metrics-primitive.md) rewrites cost as a metric source and deletes every
// value below; until then each chart reads one of them through `useLive`.
//
// Every value is served `"db"` with SQL over the priced token ledger
// (`claude_spend_hours_v` joined to `claude_usage_sources`,
// `server/internal/answers.ts`), recomputed on every ledger, price or source
// write. A "session" is a `conv:` or `session:` ledger source (a conversation's
// whole chain and its sub-agents are one); `cli:` spend counts in the per-day
// cost and tokens only. A top session's live conversation (title, status) is
// read on the web from `costConversations` below.

/** Which sessions a chart counts (the `repoOnly` config toggle). */
export const COST_SCOPES = ["all", "repo"] as const;
export type CostScope = (typeof COST_SCOPES)[number];

const scopeParams = { scope: z.enum(COST_SCOPES) };

/** How many sessions the top-sessions table lists (the old endpoint's only caller asked for 50). */
export const TOP_SESSIONS = 50;

/**
 * How many UTC days a per-day cost series holds: ten years of history. The
 * loader keeps the newest days and says `truncated` when it dropped older ones.
 */
export const COST_DAYS_MAX = 3660;

/** A day's per-model / per-family breakdown: one key per model (family) in use. */
const PER_MODEL_REASON =
  "one key per model (or model family) used — the handful of Claude models, never one per session";

const CostDaySchema = z.object({
  /** UTC day, `YYYY-MM-DD`. */
  date: z.string(),
  /** Dollars per canonical model id, rounded to the cent. */
  byModel: wholeRecord(z.number(), { reason: PER_MODEL_REASON }),
  /** The day's exact dollars (unrounded, so running sums round once). */
  cost: z.number(),
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
});
export type CostDay = z.infer<typeof CostDaySchema>;

/**
 * Cost and tokens per UTC day (the daily-cost, token-mix and cumulative
 * charts, and the KPIs — cumulative, the last-7-days sum and the per-day
 * average are derived in the browser, where "today" moves with the clock).
 *
 * BOUND: one entry per UTC day that recorded usage, over the whole permanent
 * history (the archive is never truncated) — at most 366 per year of history,
 * each holding at most one key per model used that day — capped at
 * `COST_DAYS_MAX` (the newest days; `truncated` when older ones were dropped).
 * Not capped by a range param on purpose: the charts draw every day, and this
 * value is interim (metrics P2 reads ranges).
 */
export const costDaily = liveValue("stats.cost.daily", {
  schema: z.object({
    days: cappedList(CostDaySchema, { max: COST_DAYS_MAX }),
    /** Whether days older than the newest `COST_DAYS_MAX` were dropped. */
    truncated: z.boolean(),
    /** Every model in `days`, sorted. */
    models: wholeList(z.string(), { reason: PER_MODEL_REASON }),
    /** Sessions (transcripts) counted, whatever their date. */
    sessionCount: z.number(),
  }),
  params: scopeParams,
});

const FamilyDaySchema = z.object({
  /** Sessions that used the family (a session counts once per family it used). */
  sessions: z.number(),
  /** The session's cost and tokens, split evenly across the families it used. */
  cost: z.number(),
  tokens: z.number(),
});

const SessionDaySchema = z.object({
  /** UTC day of the session's last activity, `YYYY-MM-DD`. */
  date: z.string(),
  sessionCount: z.number(),
  totalCost: z.number(),
  totalTokens: z.number(),
  byFamily: wholeRecord(FamilyDaySchema, { reason: PER_MODEL_REASON }),
});
export type CostSessionDay = z.infer<typeof SessionDaySchema>;

/**
 * Sessions per UTC day of their last activity, by model family (the
 * sessions-per-day chart and the average-per-conversation chart, whose
 * averages and 7-day rolling windows are derived in the browser).
 *
 * BOUND: one entry per UTC day with a session ending in it, over the whole
 * history — at most 366 per year, each holding at most one key per family —
 * capped at `COST_DAYS_MAX` (the newest days; `truncated` when older ones
 * were dropped).
 */
export const costSessionsDaily = liveValue("stats.cost.sessions-daily", {
  schema: z.object({
    days: cappedList(SessionDaySchema, { max: COST_DAYS_MAX }),
    /** Whether days older than the newest `COST_DAYS_MAX` were dropped. */
    truncated: z.boolean(),
    /** Every family in `days`, sorted. */
    families: wholeList(z.string(), { reason: PER_MODEL_REASON }),
  }),
  params: scopeParams,
});

/**
 * How many sessions fall in each cost bucket, on a log-spaced 1-2-5 ladder.
 *
 * BOUND: one bucket below a cent plus three per decade between the cheapest
 * and the dearest session (about 16 for a $0.01 – $1k spread), whatever the
 * number of sessions.
 */
export const costDistribution = liveValue("stats.cost.distribution", {
  schema: z.object({
    buckets: wholeList(z.object({ label: z.string(), count: z.number() }), {
      reason:
        "a 1-2-5 ladder over the sessions' cost spread (about 16 buckets for $0.01 – $1k), whatever the number of sessions",
    }),
  }),
  params: scopeParams,
});

const TopSessionSchema = z.object({
  /** The source's own id: a conversation id (`conv:`), or a Claude session id (`session:`). */
  sessionId: z.string(),
  /** The conversation the source is, for a `conv:` source; null otherwise. */
  conversationId: z.string().nullable(),
  /** The source's recorded title (`claude_usage_sources`); the live conversation's wins. */
  title: z.string().nullable(),
  totalCost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  lastActivity: z.string(),
  modelsUsed: wholeList(z.string(), { reason: PER_MODEL_REASON }),
});
export type CostTopSession = z.infer<typeof TopSessionSchema>;

/**
 * The `TOP_SESSIONS` dearest sessions, dearest first. `title` is the source's
 * recorded one (kept after a conversation is deleted); the live conversation,
 * when there is one, comes from `costConversations` and wins.
 *
 * BOUND: at most `TOP_SESSIONS` (50) rows.
 */
export const costTopSessions = liveValue("stats.cost.top-sessions", {
  schema: z.object({
    rows: cappedList(TopSessionSchema, { max: TOP_SESSIONS }),
  }),
  params: scopeParams,
});

/**
 * A conversation by id — lookup-only (`:rows`, read `useLive(c, { ids })`):
 * the top-sessions table reads its at most `TOP_SESSIONS` rows'
 * conversations, so a rename or a status change reaches the row live.
 */
export const costConversations = liveCollection("stats.cost.conversations", {
  from: conversationsEntityRef,
  carry: { pick: ["id", "title", "status"] },
  baseExposures: false,
  id: "id",
});
