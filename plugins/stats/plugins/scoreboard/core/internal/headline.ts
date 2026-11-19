import type {
  Scoreboard,
  ScoreboardMetric,
  ScoreboardSeries,
  ScoreboardStat,
} from "./value";

/** The Monday (UTC) of the week a `YYYY-MM-DD` day falls in. */
export function weekOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(ms - dow * 86_400_000).toISOString().slice(0, 10);
}

const SHORT: Record<ScoreboardMetric, string> = {
  "update-e2e": "update",
  navigate: "navigation",
  input: "click/key",
  "page-load": "page load",
  "thread-lag": "server lag",
};

// A change under this share is noise at a week's sample sizes.
const MOVE = 0.1;

export type Trend = "better" | "worse" | "flat" | "unknown";

/** Lower is better for every latency; `unknown` when either side has no data. */
export function trendOf(before: number | null, after: number | null): Trend {
  if (before === null || after === null || before === 0) return "unknown";
  const r = after / before - 1;
  return r <= -MOVE ? "better" : r >= MOVE ? "worse" : "flat";
}

function ms(v: number | null): string {
  if (v === null) return "–";
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
}

/**
 * The series a person's experience is read from: their own tabs once there
 * are any on both sides, else every tab (automated ones mixed in — the only
 * record before the split, and continuous across it), else the server's own.
 */
export function feltSeries(
  sb: Scoreboard,
  metric: ScoreboardMetric,
): ScoreboardSeries | undefined {
  const of = (a: ScoreboardSeries["audience"]) =>
    sb.latency.find((s) => s.metric === metric && s.audience === a);
  const both = (s: ScoreboardSeries | undefined) =>
    s !== undefined && s.last7.count > 0 && s.prev7.count > 0;
  const real = of("real");
  if (both(real)) return real;
  const all = of("all");
  if (both(all)) return all;
  return of("server") ?? real ?? all;
}

function p95Move(s: ScoreboardSeries | undefined): {
  before: ScoreboardStat["p95Ms"];
  after: ScoreboardStat["p95Ms"];
  trend: Trend;
} {
  const before = s?.prev7.p95Ms ?? null;
  const after = s?.last7.p95Ms ?? null;
  return { before, after, trend: trendOf(before, after) };
}

/**
 * One line answering "faster or slower, and converging?": the last 7 whole
 * days against the 7 before, p95 of each felt metric, and how many latencies
 * moved which way. The Performance supervisor links to the scoreboard with it.
 */
export function scoreboardHeadline(sb: Scoreboard): string {
  const moves = (Object.keys(SHORT) as ScoreboardMetric[]).map((m) => ({
    m,
    ...p95Move(feltSeries(sb, m)),
  }));
  const better = moves.filter((x) => x.trend === "better").length;
  const worse = moves.filter((x) => x.trend === "worse").length;
  const known = moves.filter((x) => x.trend !== "unknown");
  const verdict =
    known.length === 0
      ? "Not enough data yet"
      : better > worse
        ? "Getting faster"
        : worse > better
          ? "Getting slower"
          : "Holding steady";
  const parts = known.map(
    (x) => `${SHORT[x.m]} ${ms(x.before)} → ${ms(x.after)}`,
  );
  return `${verdict} (p95, last 7 days vs the 7 before: ${better} better, ${worse} worse)${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}.`;
}
