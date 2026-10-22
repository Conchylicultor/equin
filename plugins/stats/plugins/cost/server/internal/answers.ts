import {
  modelMeta,
  parseModelId,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  canonicalModel,
  type AggregateBundle as CostBundle,
  type DailyRow,
  type PerSession,
} from "./load-usage";
import { logCostBuckets, type CostBucket } from "./distribution";
import { roundCents } from "../../shared/derive";
import {
  TOP_SESSIONS,
  type CostDay,
  type CostScope,
  type CostSessionDay,
} from "../../shared/values";

// Each `stats.cost.*` value's answer, computed from the shared bundle — pure,
// so `./served.ts` is only wiring. The arithmetic is the deleted endpoints'
// (`/api/stats/cost/*`); what several charts shared is served once and the
// rest is derived in the browser (`../../shared/derive.ts`).

function modelFamily(canonical: string): string {
  const id = parseModelId(canonical);
  return id.ok
    ? modelMeta(id.id).family
    : (canonical.split("-")[0] ?? canonical);
}

function scopedDaily(b: CostBundle, scope: CostScope): DailyRow[] {
  if (scope === "all") return b.daily;
  return b.daily.filter((r) => b.projectIsSingularity.get(r.project) ?? false);
}

function scopedSessions(b: CostBundle, scope: CostScope): PerSession[] {
  return scope === "all"
    ? b.sessions
    : b.sessions.filter((s) => s.isSingularity);
}

/** `stats.cost.daily`: cost by model and tokens by kind, per UTC day. */
export function dailyAnswer(
  b: CostBundle,
  scope: CostScope,
): { days: CostDay[]; models: string[]; sessionCount: number } {
  const perDay = new Map<
    string,
    { day: CostDay; byModel: Map<string, number> }
  >();
  const allModels = new Set<string>();
  for (const r of scopedDaily(b, scope)) {
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
    d.cost += r.totalCost;
    d.input += r.inputTokens;
    d.output += r.outputTokens;
    d.cacheCreation += r.cacheCreationTokens;
    d.cacheRead += r.cacheReadTokens;
    for (const mb of r.modelBreakdowns) {
      const key = canonicalModel(mb.modelName);
      allModels.add(key);
      entry.byModel.set(key, (entry.byModel.get(key) ?? 0) + mb.cost);
    }
  }
  const models = [...allModels].sort();
  const days = [...perDay.keys()].sort().map((date) => {
    const { day, byModel } = perDay.get(date)!;
    for (const m of models) day.byModel[m] = roundCents(byModel.get(m) ?? 0);
    return day;
  });
  return {
    days,
    models,
    sessionCount: scopedSessions(b, scope).length,
  };
}

/**
 * `stats.cost.sessions-daily`: sessions per UTC day of their last activity,
 * by model family — a session counts once in every family it used, and its
 * cost and tokens are split evenly across them.
 */
export function sessionsDailyAnswer(
  b: CostBundle,
  scope: CostScope,
): { days: CostSessionDay[]; families: string[] } {
  const byDate = new Map<string, CostSessionDay>();
  const allFamilies = new Set<string>();
  for (const s of scopedSessions(b, scope)) {
    const date = s.lastActivity.slice(0, 10);
    if (!date) continue;
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
    day.sessionCount += 1;
    day.totalCost += s.cost;
    day.totalTokens += s.totalTokens;
    const families = [
      ...new Set(s.modelsUsed.map((m) => modelFamily(canonicalModel(m)))),
    ];
    if (families.length === 0) continue;
    const share = 1 / families.length;
    for (const fam of families) {
      allFamilies.add(fam);
      const f = day.byFamily[fam] ?? { sessions: 0, cost: 0, tokens: 0 };
      f.sessions += 1;
      f.cost += s.cost * share;
      f.tokens += s.totalTokens * share;
      day.byFamily[fam] = f;
    }
  }
  const days = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return { days, families: [...allFamilies].sort() };
}

/** `stats.cost.distribution`: sessions per log-spaced cost bucket. */
export function distributionAnswer(
  b: CostBundle,
  scope: CostScope,
): { buckets: CostBucket[] } {
  return {
    buckets: logCostBuckets(scopedSessions(b, scope).map((s) => s.cost)),
  };
}

/** `stats.cost.top-sessions`: the `TOP_SESSIONS` dearest sessions. */
export function topSessionsAnswer(b: CostBundle, scope: CostScope) {
  const sorted = [...scopedSessions(b, scope)].sort((x, y) => y.cost - x.cost);
  return {
    rows: sorted.slice(0, TOP_SESSIONS).map((s) => {
      const meta = b.archivedMeta.get(s.sessionId);
      return {
        sessionId: s.sessionId,
        conversationId: meta?.conversationId ?? null,
        title: meta?.title ?? null,
        totalCost: roundCents(s.cost),
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheCreationTokens: s.cacheCreationTokens,
        cacheReadTokens: s.cacheReadTokens,
        lastActivity: s.lastActivity,
        modelsUsed: s.modelsUsed.map(canonicalModel),
      };
    }),
  };
}
