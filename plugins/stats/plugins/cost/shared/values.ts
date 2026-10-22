import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

// The Stats → Cost reads. INTERIM: metrics P2 (research/2026-09-30-global-
// metrics-primitive.md) rewrites cost as a metric source and deletes every
// value below; until then each chart reads one of them through `useLive`.
//
// Every value is served external `"notified"` over ONE shared, memoized
// bundle (`server/internal/load-usage.ts`): the transcripts under
// `~/.claude/projects` (a directory watch while a tuple is subscribed), the
// price table (`onPriceTableUpdated`) and the permanent archive. None reads
// Postgres: a session's conversation (title, status, link) is read on the
// web from `sessionConversations` below.

/** Which sessions a chart counts (the `singularityOnly` config toggle). */
export const COST_SCOPES = ["all", "singularity"] as const;
export type CostScope = (typeof COST_SCOPES)[number];

const scopeParams = { scope: z.enum(COST_SCOPES) };

/** How many sessions the top-sessions table lists (the old endpoint's only caller asked for 50). */
export const TOP_SESSIONS = 50;

const CostDaySchema = z.object({
  /** UTC day, `YYYY-MM-DD`. */
  date: z.string(),
  /** Dollars per canonical model id, rounded to the cent. */
  byModel: z.record(z.string(), z.number()),
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
 * each holding at most one key per model used that day. Not capped by a range
 * param on purpose: the charts draw every day, and this value is interim
 * (metrics P2 reads ranges).
 */
export const costDaily = liveValue("stats.cost.daily", {
  schema: z.object({
    days: z.array(CostDaySchema),
    /** Every model in `days`, sorted. */
    models: z.array(z.string()),
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
  byFamily: z.record(z.string(), FamilyDaySchema),
});
export type CostSessionDay = z.infer<typeof SessionDaySchema>;

/**
 * Sessions per UTC day of their last activity, by model family (the
 * sessions-per-day chart and the average-per-conversation chart, whose
 * averages and 7-day rolling windows are derived in the browser).
 *
 * BOUND: one entry per UTC day with a session ending in it, over the whole
 * history — at most 366 per year, each holding at most one key per family.
 */
export const costSessionsDaily = liveValue("stats.cost.sessions-daily", {
  schema: z.object({
    days: z.array(SessionDaySchema),
    /** Every family in `days`, sorted. */
    families: z.array(z.string()),
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
    buckets: z.array(z.object({ label: z.string(), count: z.number() })),
  }),
  params: scopeParams,
});

const TopSessionSchema = z.object({
  sessionId: z.string(),
  conversationId: z.string().nullable(),
  title: z.string().nullable(),
  totalCost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  lastActivity: z.string(),
  modelsUsed: z.array(z.string()),
});
export type CostTopSession = z.infer<typeof TopSessionSchema>;

/**
 * The `TOP_SESSIONS` dearest sessions, dearest first. `conversationId` /
 * `title` are the archive's snapshot (taken at capture, kept after the
 * conversation is deleted); the live conversation, when there is one, comes
 * from `sessionConversations` and wins.
 *
 * BOUND: at most `TOP_SESSIONS` (50) rows.
 */
export const costTopSessions = liveValue("stats.cost.top-sessions", {
  schema: z.object({ rows: z.array(TopSessionSchema) }),
  params: scopeParams,
});

/**
 * A conversation by the Claude session it ran — the one key a transcript
 * carries. Lookup-only (`:rows`, read `useLive(c, { ids: sessionIds })`): the
 * top-sessions table reads its at most `TOP_SESSIONS` rows' conversations, so
 * a rename or a status change reaches the row live. Keyed by
 * `claudeSessionId` (unique per conversation), which no conversations
 * collection is keyed or filterable by.
 */
export const sessionConversations = liveCollection(
  "stats.cost.session-conversations",
  {
    from: conversationsEntityRef,
    carry: { pick: ["claudeSessionId", "id", "title", "status"] },
    baseExposures: false,
    id: "claudeSessionId",
  },
);
