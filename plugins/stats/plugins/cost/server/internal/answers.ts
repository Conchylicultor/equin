import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  modelIdFromCliName,
  modelMeta,
  parseModelId,
} from "@plugins/conversations/plugins/model-provider/core";
import { SPEND_SOURCE_PREFIX } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { _claudeUsageSources } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import { _claudeSpendDays, _claudeSpendSources } from "./tables";
import { logCostBuckets, type CostBucket } from "./distribution";
import { roundCents } from "../../shared/derive";
import {
  COST_DAYS_MAX,
  TOP_SESSIONS,
  type CostDay,
  type CostScope,
  type CostSessionDay,
  type CostTopSession,
} from "../../shared/values";

// Each `stats.cost.*` value's answer, read from Stats → Cost's two rollups of
// the priced token ledger (`./tables.ts`, kept by `./rollups.ts`: every hour
// priced with the price version in force at it, summed per UTC day / model /
// repo flag, and per source) joined to each source's row
// (`claude_usage_sources`: the repo scope, a title). `./served.ts` is only
// wiring.
//
// - A "session" is a ledger SOURCE that is a conversation or a session equin
//   did not launch (`conv:` / `session:` — a conversation's whole chain and
//   its sub-agents are one). A `cli:` source (every one-shot call of one
//   kind) is spend, not a session: it counts in the per-day cost and tokens,
//   never in the session counts, the distribution or the top sessions.
// - An hour the view cannot price (`cost_usd` NULL) adds no dollars; its
//   tokens still count. The daily price refresh files `cost-unpriced-model`
//   for it (price-table's `reportUnpricedModels`), so it is never a silent $0.
// - Scope `repo` keeps the sources whose row says `is_repo` (a source with no
//   row is not the repo's).

// CLI model name (e.g. "claude-opus-4-7-20250101") → model id "opus-4-7"; a
// name outside the id grammar (an old "claude-3-5-sonnet" spelling) stays as is.
function canonicalModel(name: string): string {
  const id = modelIdFromCliName(name);
  return id.ok ? id.id : name;
}

function modelFamily(canonical: string): string {
  const id = parseModelId(canonical);
  return id.ok
    ? modelMeta(id.id).family
    : (canonical.split("-")[0] ?? canonical);
}

const d = _claudeSpendDays;
const r = _claudeSpendSources;
const s = _claudeUsageSources;

/** The scoped per-source rows: the rollup joined to each source's row. */
function scopedSources(scope: CostScope): SQL {
  return sql`
    FROM ${r}
    LEFT JOIN ${s} ON ${s.source} = ${r.source}
   WHERE ${r.source} NOT LIKE ${`${SPEND_SOURCE_PREFIX.cli}%`}
     AND ${scope === "repo" ? sql`coalesce(${s.isRepo}, false)` : sql`true`}`;
}

/** The newest `COST_DAYS_MAX` of `days` (ascending by date), and whether older ones were dropped. */
function newestDays<D>(days: D[]): { days: D[]; truncated: boolean } {
  return days.length > COST_DAYS_MAX
    ? { days: days.slice(-COST_DAYS_MAX), truncated: true }
    : { days, truncated: false };
}

const DayModelRowSchema = z.object({
  date: z.string(),
  model: z.string(),
  cost: z.number(),
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
});

const CountSchema = z.object({ count: z.number().int() });

/** `stats.cost.daily`: cost by model and tokens by kind, per UTC day. */
export async function dailyAnswer(
  exec: DbExecutor,
  scope: CostScope,
): Promise<{
  days: CostDay[];
  truncated: boolean;
  models: string[];
  sessionCount: number;
}> {
  const [rows, [count]] = await Promise.all([
    executeRows(exec, {
      label: "stats cost per day and model",
      query: sql`
        SELECT to_char(${d.day}, 'YYYY-MM-DD') AS date, ${d.model} AS model,
               sum(${d.costUsd})::float8 AS cost,
               sum(${d.input})::float8 AS input,
               sum(${d.output})::float8 AS output,
               sum(${d.cacheCreation})::float8 AS "cacheCreation",
               sum(${d.cacheRead})::float8 AS "cacheRead"
          FROM ${d}
         WHERE ${scope === "repo" ? d.isRepo : sql`true`}
         GROUP BY 1, 2`,
      row: DayModelRowSchema,
    }),
    executeRows(exec, {
      label: "stats cost session count",
      query: sql`SELECT count(*)::int AS count ${scopedSources(scope)}`,
      row: CountSchema,
    }),
  ]);
  const perDay = new Map<
    string,
    { day: CostDay; byModel: Map<string, number> }
  >();
  const allModels = new Set<string>();
  for (const r of rows) {
    let entry = perDay.get(r.date);
    if (!entry) {
      entry = {
        day: {
          date: r.date,
          byModel: {},
          cost: 0,
          input: 0,
          output: 0,
          cacheCreation: 0,
          cacheRead: 0,
        },
        byModel: new Map(),
      };
      perDay.set(r.date, entry);
    }
    const d = entry.day;
    d.cost += r.cost;
    d.input += r.input;
    d.output += r.output;
    d.cacheCreation += r.cacheCreation;
    d.cacheRead += r.cacheRead;
    const key = canonicalModel(r.model);
    allModels.add(key);
    entry.byModel.set(key, (entry.byModel.get(key) ?? 0) + r.cost);
  }
  const models = [...allModels].sort();
  const days = [...perDay.keys()].sort().map((date) => {
    const { day, byModel } = perDay.get(date)!;
    for (const m of models) day.byModel[m] = roundCents(byModel.get(m) ?? 0);
    return day;
  });
  return { ...newestDays(days), models, sessionCount: count?.count ?? 0 };
}

const SessionRowSchema = z.object({
  source: z.string(),
  cost: z.number(),
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
  lastActivity: z.string(),
  models: z.array(z.string()),
  title: z.string().nullable(),
});
type SessionRow = z.infer<typeof SessionRowSchema>;

/** Each scoped session's totals; `limit`: the dearest that many only. */
function readSessions(
  exec: DbExecutor,
  scope: CostScope,
  limit: number | null,
): Promise<SessionRow[]> {
  return executeRows(exec, {
    label: "stats cost per session",
    query: sql`
      SELECT ${r.source} AS source, ${r.costUsd} AS cost,
             ${r.input}::float8 AS input, ${r.output}::float8 AS output,
             ${r.cacheCreation}::float8 AS "cacheCreation",
             ${r.cacheRead}::float8 AS "cacheRead",
             to_char(${r.lastHour} AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "lastActivity",
             ${r.models} AS models,
             ${s.title} AS title
        ${scopedSources(scope)}
       ${limit === null ? sql`` : sql`ORDER BY ${r.costUsd} DESC, ${r.source} LIMIT ${limit}`}`,
    row: SessionRowSchema,
  });
}

const tokensOf = (r: SessionRow): number =>
  r.input + r.output + r.cacheCreation + r.cacheRead;

/**
 * `stats.cost.sessions-daily`: sessions per UTC day of their last activity,
 * by model family — a session counts once in every family it used, and its
 * cost and tokens are split evenly across them.
 */
export async function sessionsDailyAnswer(
  exec: DbExecutor,
  scope: CostScope,
): Promise<{ days: CostSessionDay[]; truncated: boolean; families: string[] }> {
  const byDate = new Map<string, CostSessionDay>();
  const allFamilies = new Set<string>();
  for (const r of await readSessions(exec, scope, null)) {
    const date = r.lastActivity;
    let day = byDate.get(date);
    if (!day) {
      day = {
        date,
        sessionCount: 0,
        totalCost: 0,
        totalTokens: 0,
        byFamily: {},
      };
      byDate.set(date, day);
    }
    const tokens = tokensOf(r);
    day.sessionCount += 1;
    day.totalCost += r.cost;
    day.totalTokens += tokens;
    const families = [
      ...new Set(r.models.map((m) => modelFamily(canonicalModel(m)))),
    ];
    if (families.length === 0) continue;
    const share = 1 / families.length;
    for (const fam of families) {
      allFamilies.add(fam);
      const f = day.byFamily[fam] ?? { sessions: 0, cost: 0, tokens: 0 };
      f.sessions += 1;
      f.cost += r.cost * share;
      f.tokens += tokens * share;
      day.byFamily[fam] = f;
    }
  }
  const days = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return { ...newestDays(days), families: [...allFamilies].sort() };
}

/** `stats.cost.distribution`: sessions per log-spaced cost bucket. */
export async function distributionAnswer(
  exec: DbExecutor,
  scope: CostScope,
): Promise<{ buckets: CostBucket[] }> {
  const sessions = await readSessions(exec, scope, null);
  return { buckets: logCostBuckets(sessions.map((r) => r.cost)) };
}

/** A source's own id and the conversation it is, read off its grammar. */
function sourceIdentity(source: string): {
  sessionId: string;
  conversationId: string | null;
} {
  const conv = SPEND_SOURCE_PREFIX.conversation;
  if (source.startsWith(conv)) {
    const id = source.slice(conv.length);
    return { sessionId: id, conversationId: id };
  }
  const session = SPEND_SOURCE_PREFIX.session;
  if (source.startsWith(session))
    return { sessionId: source.slice(session.length), conversationId: null };
  throw new Error(`not a session source: ${source}`);
}

/** `stats.cost.top-sessions`: the `TOP_SESSIONS` dearest sessions. */
export async function topSessionsAnswer(
  exec: DbExecutor,
  scope: CostScope,
): Promise<{ rows: CostTopSession[] }> {
  const rows = await readSessions(exec, scope, TOP_SESSIONS);
  return {
    rows: rows.map((r) => ({
      ...sourceIdentity(r.source),
      title: r.title,
      totalCost: roundCents(r.cost),
      inputTokens: r.input,
      outputTokens: r.output,
      cacheCreationTokens: r.cacheCreation,
      cacheReadTokens: r.cacheRead,
      lastActivity: r.lastActivity,
      modelsUsed: [...new Set(r.models.map(canonicalModel))],
    })),
  };
}
