import type { CostDay, CostSessionDay } from "./values";

// What the browser derives from the two per-day series (`costDaily`,
// `costSessionsDaily`) — the arithmetic the deleted cumulative / totals /
// avg-per-conversation endpoints did on the server, unchanged, so one served
// series feeds several charts.

export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Running total of `days`' cost, one point per day, rounded to the cent. */
export function cumulativeCost(
  days: readonly CostDay[],
): { date: string; cost: number }[] {
  let running = 0;
  return days.map((d) => {
    running += d.cost;
    return { date: d.date, cost: roundCents(running) };
  });
}

export interface CostTotals {
  totalCost: number;
  totalTokens: number;
  byTokenKind: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  /** Cost on the days from seven UTC days before `now` to today. */
  last7Cost: number;
  avgDailyCost: number;
  activeDays: number;
}

/** The KPI totals over `days`; "the last 7 days" is measured from `now`. */
export function costTotals(days: readonly CostDay[], now: Date): CostTotals {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  const last7Cutoff = cutoff.toISOString().slice(0, 10);
  let totalCost = 0;
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let last7Cost = 0;
  for (const d of days) {
    totalCost += d.cost;
    input += d.input;
    output += d.output;
    cacheCreation += d.cacheCreation;
    cacheRead += d.cacheRead;
    if (d.date >= last7Cutoff) last7Cost += d.cost;
  }
  const activeDays = days.length;
  return {
    totalCost: roundCents(totalCost),
    totalTokens: input + output + cacheCreation + cacheRead,
    byTokenKind: { input, output, cacheCreation, cacheRead },
    last7Cost: roundCents(last7Cost),
    avgDailyCost: roundCents(activeDays > 0 ? totalCost / activeDays : 0),
    activeDays,
  };
}

export interface AvgPerConversationPoint {
  date: string;
  avgCost: number;
  avgTokens: number;
  sessionCount: number;
  byFamily: Record<string, { avgCost: number; avgTokens: number }>;
  rolling7ByFamily: Record<
    string,
    { cost: number | null; tokens: number | null }
  >;
  rolling7Cost: number | null;
  rolling7Tokens: number | null;
}

/**
 * Average cost and tokens per conversation per day, overall and by family,
 * with a 7-active-day rolling window weighted by session count (not an
 * average of averages). `days` is sorted by date.
 */
export function avgPerConversation(
  days: readonly CostSessionDay[],
  families: readonly string[],
): AvgPerConversationPoint[] {
  return days.map((day, i) => {
    const avgCost =
      day.sessionCount > 0 ? roundCents(day.totalCost / day.sessionCount) : 0;
    const avgTokens =
      day.sessionCount > 0 ? Math.round(day.totalTokens / day.sessionCount) : 0;

    const win = days.slice(Math.max(0, i - 6), i + 1);
    const wCost = win.reduce((acc, d) => acc + d.totalCost, 0);
    const wTokens = win.reduce((acc, d) => acc + d.totalTokens, 0);
    const wCount = win.reduce((acc, d) => acc + d.sessionCount, 0);

    const byFamily: AvgPerConversationPoint["byFamily"] = {};
    const rolling7ByFamily: AvgPerConversationPoint["rolling7ByFamily"] = {};
    for (const fam of families) {
      const f = day.byFamily[fam];
      byFamily[fam] = {
        avgCost:
          day.sessionCount > 0
            ? roundCents((f?.cost ?? 0) / day.sessionCount)
            : 0,
        avgTokens:
          day.sessionCount > 0
            ? Math.round((f?.tokens ?? 0) / day.sessionCount)
            : 0,
      };
      const wFamCost = win.reduce(
        (acc, d) => acc + (d.byFamily[fam]?.cost ?? 0),
        0,
      );
      const wFamTokens = win.reduce(
        (acc, d) => acc + (d.byFamily[fam]?.tokens ?? 0),
        0,
      );
      rolling7ByFamily[fam] = {
        cost: wCount > 0 ? roundCents(wFamCost / wCount) : null,
        tokens: wCount > 0 ? Math.round(wFamTokens / wCount) : null,
      };
    }

    return {
      date: day.date,
      avgCost,
      avgTokens,
      sessionCount: day.sessionCount,
      byFamily,
      rolling7ByFamily,
      rolling7Cost: wCount > 0 ? roundCents(wCost / wCount) : null,
      rolling7Tokens: wCount > 0 ? Math.round(wTokens / wCount) : null,
    };
  });
}
