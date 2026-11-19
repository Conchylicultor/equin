import {
  BUCKET_COUNT,
  percentileFromCounts,
  type DailyLatency,
} from "@plugins/debug/plugins/latency-ledger/core";
import { loadDailyLatency } from "@plugins/debug/plugins/latency-ledger/server";
import { readBootStartsSince } from "@plugins/debug/plugins/boot-events/server";
import {
  loadReportTrend,
  type ReportTrend,
} from "@plugins/reports/plugins/engine/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  SCOREBOARD_DAYS,
  SCOREBOARD_KINDS_MAX,
  SCOREBOARD_METRICS,
  weekOf,
  type Scoreboard,
  type ScoreboardDay,
  type ScoreboardFixKind,
  type ScoreboardKind,
  type ScoreboardMetric,
  type ScoreboardSeries,
  type ScoreboardStat,
  type ScoreboardWeek,
} from "../../core";
import { readFixCommits, type FixCommit } from "./fix-commits";

const DAY_MS = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

type LatencyRow = DailyLatency["metrics"][number];

/** Days merged into one stat: their histograms added, never their p95s averaged. */
function mergeStat(rows: readonly LatencyRow[]): ScoreboardStat {
  const counts = new Array<number>(BUCKET_COUNT).fill(0);
  let count = 0;
  let maxMs = 0;
  for (const r of rows) {
    r.counts.forEach((n, i) => (counts[i] = (counts[i] ?? 0) + n));
    count += r.count;
    maxMs = Math.max(maxMs, r.maxMs ?? 0);
  }
  return count === 0
    ? { count: 0, p50Ms: null, p95Ms: null }
    : {
        count,
        p50Ms: percentileFromCounts(counts, 0.5, maxMs),
        p95Ms: percentileFromCounts(counts, 0.95, maxMs),
      };
}

function latencySeries(
  daily: DailyLatency,
  weeks: readonly string[],
  last7: ReadonlySet<string>,
  prev7: ReadonlySet<string>,
): ScoreboardSeries[] {
  const metrics = new Set<string>(SCOREBOARD_METRICS);
  const groups = new Map<string, LatencyRow[]>();
  for (const r of daily.metrics) {
    if (!metrics.has(r.metric) || r.count === 0) continue;
    const key = `${r.metric}|${r.clientKind}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: ScoreboardSeries[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) continue;
    out.push({
      metric: first.metric as ScoreboardMetric,
      audience: first.clientKind,
      days: [...rows]
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((r) => ({ day: r.day, ...mergeStat([r]) })),
      weeks: weeks.map((week) => ({
        week,
        ...mergeStat(rows.filter((r) => weekOf(r.day) === week)),
      })),
      last7: mergeStat(rows.filter((r) => last7.has(r.day))),
      prev7: mergeStat(rows.filter((r) => prev7.has(r.day))),
    });
  }
  const order = (s: ScoreboardSeries) =>
    SCOREBOARD_METRICS.indexOf(s.metric) * 10 +
    ["real", "automated", "all", "server"].indexOf(s.audience);
  return out.sort((a, b) => order(a) - order(b));
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

const perRestart = (
  reports: number | null,
  restarts: number | null,
): number | null =>
  reports === null || restarts === null || restarts === 0
    ? null
    : reports / restarts;

/** The scoreboard for the window ending now (`stats.scoreboard`'s loader). */
export async function loadScoreboard(now = Date.now()): Promise<Scoreboard> {
  const today = dayOf(now);
  const sinceMs =
    Date.parse(`${today}T00:00:00Z`) - (SCOREBOARD_DAYS - 1) * DAY_MS;
  const sinceDay = dayOf(sinceMs);
  const dayList: string[] = [];
  for (let ms = sinceMs; dayOf(ms) <= today; ms += DAY_MS)
    dayList.push(dayOf(ms));
  const weeks = [...new Set(dayList.map(weekOf))];
  // Whole days only: today is still filling.
  const last7 = new Set(dayList.slice(-8, -1));
  const prev7 = new Set(dayList.slice(-15, -8));

  const [daily, trend, boots, fixCommits] = await Promise.all([
    loadDailyLatency(sinceDay, now),
    loadReportTrend(sinceDay),
    readBootStartsSince(runtimeNamespace(), sinceMs),
    readFixCommits(sinceMs),
  ]);

  const restartsKnownFrom = boots.knownFrom;
  const bootsByDay = new Map<string, number>();
  for (const s of boots.starts)
    bootsByDay.set(dayOf(s), (bootsByDay.get(dayOf(s)) ?? 0) + 1);
  // The day knowledge begins is itself partial: unknown too.
  const restartsOn = (day: string): number | null =>
    restartsKnownFrom !== null && day <= dayOf(restartsKnownFrom)
      ? null
      : (bootsByDay.get(day) ?? 0);

  // Occurrences: from the day after the history began (that day is partial).
  // New causes and fixes: from 7 days before it — the oldest report rows (and
  // their fixes) alive when it began.
  const historyMs =
    trend.historyFrom === null
      ? null
      : Date.parse(`${trend.historyFrom}T00:00:00Z`);
  const reportsKnownFrom =
    historyMs === null ? null : dayOf(historyMs + DAY_MS);
  const convergenceKnownFrom =
    historyMs === null ? null : dayOf(historyMs - 7 * DAY_MS);
  const reportsByDay = new Map<string, number>();
  for (const o of trend.occurrences)
    reportsByDay.set(o.day, (reportsByDay.get(o.day) ?? 0) + o.count);
  const reportsOn = (day: string): number | null =>
    reportsKnownFrom === null || day < reportsKnownFrom
      ? null
      : (reportsByDay.get(day) ?? 0);

  const hosts = new Map(daily.hosts.map((h) => [h.day, h]));
  const days: ScoreboardDay[] = dayList.map((day) => {
    const h = hosts.get(day);
    return {
      day,
      restarts: restartsOn(day),
      calmMinutes: h?.calmMinutes ?? 0,
      pressureMinutes: h?.pressureMinutes ?? 0,
      sleptMinutes: h?.sleptMinutes ?? 0,
      unknownMinutes: h?.unknownMinutes ?? 0,
      reports: reportsOn(day),
    };
  });

  const weekRows = buildWeeks(
    weeks,
    days,
    trend,
    fixCommits,
    convergenceKnownFrom,
  );
  return {
    sinceDay,
    days,
    weeks: weekRows,
    latency: latencySeries(daily, weeks, last7, prev7),
    kinds: buildKinds(weeks, days, trend),
    fixKinds: buildFixKinds(weeks, trend, convergenceKnownFrom),
    reportsKnownFrom,
    convergenceKnownFrom,
    restartsKnownFrom,
  };
}

function buildWeeks(
  weeks: readonly string[],
  days: readonly ScoreboardDay[],
  trend: ReportTrend,
  fixCommits: readonly FixCommit[],
  knownFrom: string | null,
): ScoreboardWeek[] {
  return weeks.map((week) => {
    // A week starting before the history reaches would be an undercount.
    const known = knownFrom !== null && week >= knownFrom;
    const own = days.filter((d) => weekOf(d.day) === week);
    const restarts = sumOrNull(own.map((d) => d.restarts));
    const reports = sumOrNull(own.map((d) => d.reports));
    const inWeek = (day: string) => weekOf(day) === week;
    const commits = fixCommits.filter((c) => inWeek(dayOf(c.at)));
    return {
      week,
      days: own.length,
      restarts,
      pressureMinutes: own.reduce((n, d) => n + d.pressureMinutes, 0),
      reports,
      reportsPerRestart: perRestart(reports, restarts),
      newCauses: known
        ? trend.newCauses
            .filter((c) => inWeek(c.day))
            .reduce((n, c) => n + c.count, 0)
        : null,
      fixesLanded: known
        ? trend.fixes
            .filter((f) => inWeek(f.day))
            .reduce((n, f) => n + f.landed, 0)
        : null,
      regressed: known
        ? trend.fixes
            .filter((f) => inWeek(f.day))
            .reduce((n, f) => n + f.regressed, 0)
        : null,
      fixPushes: commits.length,
      guardPushes: commits.filter((c) => c.guard).length,
    };
  });
}

function buildKinds(
  weeks: readonly string[],
  days: readonly ScoreboardDay[],
  trend: ReportTrend,
): ScoreboardKind[] {
  const restartsOn = new Map(days.map((d) => [d.day, d.restarts]));
  const byKind = new Map<string, { day: string; count: number }[]>();
  for (const o of trend.occurrences) {
    const list = byKind.get(o.kind);
    if (list) list.push(o);
    else byKind.set(o.kind, [o]);
  }
  const knownDays = days.filter(
    (d) => d.reports !== null && d.restarts !== null,
  );
  const ratio = (
    dayset: readonly ScoreboardDay[],
    rows: { day: string; count: number }[],
  ) => {
    const set = new Set(dayset.map((d) => d.day));
    const n = rows
      .filter((r) => set.has(r.day))
      .reduce((s, r) => s + r.count, 0);
    const boots = dayset.reduce((s, d) => s + (restartsOn.get(d.day) ?? 0), 0);
    return perRestart(n, boots);
  };
  return [...byKind.entries()]
    .map(([kind, rows]) => ({
      kind,
      total: rows.reduce((s, r) => s + r.count, 0),
      perRestart: ratio(knownDays, rows),
      weeks: weeks.map((week) => ({
        week,
        perRestart: ratio(
          knownDays.filter((d) => weekOf(d.day) === week),
          rows,
        ),
      })),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, SCOREBOARD_KINDS_MAX);
}

function buildFixKinds(
  weeks: readonly string[],
  trend: ReportTrend,
  knownFrom: string | null,
): ScoreboardFixKind[] {
  if (knownFrom === null) return [];
  const known = (week: string) => week >= knownFrom;
  const byKind = new Map<string, ReportTrend["fixes"]>();
  for (const f of trend.fixes) {
    if (!known(weekOf(f.day))) continue;
    const list = byKind.get(f.kind);
    if (list) list.push(f);
    else byKind.set(f.kind, [f]);
  }
  return [...byKind.entries()]
    .map(([kind, rows]) => ({
      kind,
      landed: rows.reduce((n, r) => n + r.landed, 0),
      cameBack: rows.reduce((n, r) => n + r.regressed, 0),
      weeks: weeks.map((week) => {
        if (!known(week)) return { week, landed: null, cameBack: null };
        const own = rows.filter((r) => weekOf(r.day) === week);
        return {
          week,
          landed: own.reduce((n, r) => n + r.landed, 0),
          cameBack: own.reduce((n, r) => n + r.regressed, 0),
        };
      }),
    }))
    .sort((a, b) => b.landed - a.landed)
    .slice(0, SCOREBOARD_KINDS_MAX);
}
