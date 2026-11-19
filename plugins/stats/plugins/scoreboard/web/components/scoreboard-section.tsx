import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLive } from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { typeVar } from "@plugins/primitives/plugins/css/plugins/text/core";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  LiveChart,
  axisProps,
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
} from "@plugins/stats/plugins/commits/web";
import { METRIC_LABELS } from "@plugins/debug/plugins/latency-ledger/core";
import {
  SCOREBOARD_DAYS,
  SCOREBOARD_METRICS,
  responsivenessScoreboard,
  scoreboardHeadline,
  type Scoreboard,
  type ScoreboardMetric,
  type ScoreboardSeries,
} from "../../core";

// Whose samples each line is. A person's tabs are the answer; automated tabs
// (the agent browser, e2e runs) are shown beside them, never mixed in; "every
// tab" is both together — the only record before the split (2026-11-19), kept
// after it so the line runs through.
const AUDIENCE: Record<
  ScoreboardSeries["audience"],
  { label: string; color: string; dash?: string }
> = {
  real: { label: "Your tabs", color: "var(--chart-1)" },
  automated: { label: "Automated tabs", color: "var(--chart-3)", dash: "4 3" },
  all: { label: "Every tab", color: "var(--chart-2)", dash: "1 3" },
  server: { label: "Server", color: "var(--chart-1)" },
};

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

const shortDay = (day: string) => day.slice(5);

export function ScoreboardSection() {
  const read = useLive(responsivenessScoreboard);
  return (
    <LiveChart
      read={read}
      subject="the responsiveness scoreboard"
      size="content"
      emptyText="No measurements yet."
    >
      {(sb) => (
        <ScoreboardBody
          sb={sb}
          refresh={read.status === "unavailable" ? undefined : read.refresh}
        />
      )}
    </LiveChart>
  );
}

function ScoreboardBody({
  sb,
  refresh,
}: {
  sb: Scoreboard;
  refresh: (() => void) | undefined;
}) {
  return (
    <Stack gap="xl">
      <Stack direction="row" align="center" justify="between" gap="md">
        <Text as="p" variant="body" className="text-foreground">
          {scoreboardHeadline(sb)}
        </Text>
        {refresh && (
          <Button variant="outline" onClick={refresh}>
            Refresh
          </Button>
        )}
      </Stack>
      <Felt sb={sb} />
      <Pressure sb={sb} />
      <ReportVolume sb={sb} />
      <Converging sb={sb} />
    </Stack>
  );
}

// ─── What the user feels ────────────────────────────────────────────────────

function Felt({ sb }: { sb: Scoreboard }) {
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        What you feel
      </Text>
      <Text as="p" variant="caption" className="text-muted-foreground">
        p95 per day over the last {SCOREBOARD_DAYS} days (the faint line is the
        p50), minutes the machine slept left out. Your tabs and automated tabs
        are counted apart from 19 Nov 2026; &quot;every tab&quot; is both
        together, the only record before that. Clicks and keypresses are
        measured from the same day.
      </Text>
      <Grid minCellWidth="20rem" gap="md">
        {SCOREBOARD_METRICS.map((m) => (
          <MetricChart key={m} sb={sb} metric={m} />
        ))}
      </Grid>
      <WeeklyLatencyTable sb={sb} />
    </Stack>
  );
}

function MetricChart({
  sb,
  metric,
}: {
  sb: Scoreboard;
  metric: ScoreboardMetric;
}) {
  const series = sb.latency.filter((s) => s.metric === metric);
  const data = useMemo(
    () =>
      sb.days.map((d) => {
        const row: Record<string, string | number | null> = {
          day: shortDay(d.day),
        };
        for (const s of series) {
          const p = s.days.find((x) => x.day === d.day);
          row[`${s.audience}:p95`] = p?.p95Ms ?? null;
          row[`${s.audience}:p50`] = p?.p50Ms ?? null;
        }
        return row;
      }),
    [sb.days, series],
  );
  return (
    <Stack gap="xs">
      <Text
        as="div"
        variant="label"
        title={METRIC_LABELS[metric].what}
        className="text-foreground"
      >
        {METRIC_LABELS[metric].label}
      </Text>
      {series.length === 0 ? (
        <Text as="div" variant="caption" className="text-muted-foreground">
          Not measured yet.
        </Text>
      ) : (
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="day" {...axisProps} minTickGap={24} />
              <YAxis
                {...axisProps}
                width={52}
                scale="log"
                domain={["auto", "auto"]}
                allowDataOverflow
                tickFormatter={(v: number) => formatMs(v)}
              />
              <Tooltip
                cursor={lineCursor}
                contentStyle={tooltipContentStyle}
                labelStyle={tooltipLabelStyle}
                formatter={(v) => formatMs(typeof v === "number" ? v : null)}
              />
              {series.map((s) => (
                <Line
                  key={`${s.audience}:p95`}
                  dataKey={`${s.audience}:p95`}
                  name={`${AUDIENCE[s.audience].label} p95`}
                  stroke={AUDIENCE[s.audience].color}
                  strokeDasharray={AUDIENCE[s.audience].dash}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
              {series.map((s) => (
                <Line
                  key={`${s.audience}:p50`}
                  dataKey={`${s.audience}:p50`}
                  name={`${AUDIENCE[s.audience].label} p50`}
                  stroke={AUDIENCE[s.audience].color}
                  strokeOpacity={0.35}
                  strokeDasharray={AUDIENCE[s.audience].dash}
                  strokeWidth={1}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                  legendType="none"
                />
              ))}
              <Legend
                wrapperStyle={{ fontSize: typeVar("font-size-caption") }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Stack>
  );
}

function WeeklyLatencyTable({ sb }: { sb: Scoreboard }) {
  const weeks = sb.weeks.map((w) => w.week);
  return (
    <Scroll axis="x">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b text-left text-caption text-muted-foreground">
            <th className="px-sm py-xs font-medium">p95 by week</th>
            <th className="px-sm py-xs font-medium">Whose</th>
            {weeks.map((w) => (
              <th key={w} className="px-sm py-xs text-right font-medium">
                {shortDay(w)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sb.latency.map((s) => (
            <tr
              key={`${s.metric}:${s.audience}`}
              className="border-b border-border/50"
            >
              <td className="px-sm py-xs text-foreground">
                {METRIC_LABELS[s.metric].label}
              </td>
              <td className="px-sm py-xs text-muted-foreground">
                {AUDIENCE[s.audience].label}
              </td>
              {s.weeks.map((w) => (
                <td
                  key={w.week}
                  className="px-sm py-xs text-right tabular-nums"
                  title={`p50 ${formatMs(w.p50Ms)} · ${w.count.toLocaleString("en-US")} samples`}
                >
                  {formatMs(w.p95Ms)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

// ─── Pressure ───────────────────────────────────────────────────────────────

function Pressure({ sb }: { sb: Scoreboard }) {
  const data = sb.days.map((d) => ({
    day: shortDay(d.day),
    pressure: d.pressureMinutes,
    restarts: d.restarts,
  }));
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        Pressure
      </Text>
      <Text as="p" variant="caption" className="text-muted-foreground">
        Minutes per day the machine was short of memory (or under duress), and
        how many times this app&apos;s server restarted.
        {sb.restartsKnownFrom !== null &&
          ` Restarts are known from ${new Date(sb.restartsKnownFrom).toISOString().slice(0, 10)}.`}
      </Text>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="day" {...axisProps} minTickGap={24} />
            <YAxis yAxisId="min" {...axisProps} width={40} />
            <YAxis yAxisId="n" orientation="right" {...axisProps} width={40} />
            <Tooltip
              cursor={lineCursor}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
            />
            <Bar
              yAxisId="min"
              dataKey="pressure"
              name="Pressure minutes"
              fill="var(--chart-4)"
              isAnimationActive={false}
            />
            <Line
              yAxisId="n"
              dataKey="restarts"
              name="Restarts"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Legend wrapperStyle={{ fontSize: typeVar("font-size-caption") }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Stack>
  );
}

// ─── Report volume per restart ──────────────────────────────────────────────

const ratio = (v: number | null) =>
  v === null ? "–" : v.toFixed(v < 10 ? 2 : 0);

function ReportVolume({ sb }: { sb: Scoreboard }) {
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        Reports per restart
      </Text>
      <Text as="p" variant="caption" className="text-muted-foreground">
        Report occurrences divided by server restarts, so a day of many pushes
        does not read as a regression.{" "}
        {sb.reportsKnownFrom === null
          ? "Report volume is recorded from today on; nothing yet."
          : `Recorded from ${sb.reportsKnownFrom} (reports themselves are kept 7 days).`}
      </Text>
      {sb.kinds.length > 0 && (
        <Scroll axis="x">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b text-left text-caption text-muted-foreground">
                <th className="px-sm py-xs font-medium">Kind</th>
                <th className="px-sm py-xs text-right font-medium">Total</th>
                <th className="px-sm py-xs text-right font-medium">
                  Per restart
                </th>
                {sb.weeks.map((w) => (
                  <th
                    key={w.week}
                    className="px-sm py-xs text-right font-medium"
                  >
                    {shortDay(w.week)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/50 font-medium">
                <td className="px-sm py-xs text-foreground">All kinds</td>
                <td className="px-sm py-xs text-right tabular-nums">
                  {sb.weeks
                    .reduce((n, w) => n + (w.reports ?? 0), 0)
                    .toLocaleString("en-US")}
                </td>
                <td className="px-sm py-xs" />
                {sb.weeks.map((w) => (
                  <td
                    key={w.week}
                    className="px-sm py-xs text-right tabular-nums"
                  >
                    {ratio(w.reportsPerRestart)}
                  </td>
                ))}
              </tr>
              {sb.kinds.map((k) => (
                <tr key={k.kind} className="border-b border-border/50">
                  <td className="px-sm py-xs text-foreground">{k.kind}</td>
                  <td className="px-sm py-xs text-right tabular-nums">
                    {k.total.toLocaleString("en-US")}
                  </td>
                  <td className="px-sm py-xs text-right tabular-nums">
                    {ratio(k.perRestart)}
                  </td>
                  {k.weeks.map((w) => (
                    <td
                      key={w.week}
                      className="px-sm py-xs text-right tabular-nums"
                    >
                      {ratio(w.perRestart)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </Stack>
  );
}

// ─── Converging? ────────────────────────────────────────────────────────────

const count = (v: number | null) => (v === null ? "–" : String(v));

function Converging({ sb }: { sb: Scoreboard }) {
  const rows: {
    label: string;
    what: string;
    value: (w: Scoreboard["weeks"][number]) => string;
  }[] = [
    {
      label: "New causes",
      what: "Report fingerprints seen for the first time that week.",
      value: (w) => count(w.newCauses),
    },
    {
      label: "Fixes landed",
      what: "Reports a push to main named as fixed (the fix ledger).",
      value: (w) => count(w.fixesLanded),
    },
    {
      label: "…of which came back",
      what: "Of the fixes landed that week, how many have since fired again from code containing the fix (a cohort: it can still grow).",
      value: (w) =>
        w.regressed === null || w.fixesLanded === null
          ? "–"
          : `${w.regressed}${w.fixesLanded > 0 ? ` (${Math.round((w.regressed / w.fixesLanded) * 100)}%)` : ""}`,
    },
    {
      label: "Fix pushes landing a guard",
      what: "Pushes naming a report they fix whose commits also changed a lint rule or a check. A type-level guard or a runtime assert leaves no trace in the paths, so this is a floor.",
      value: (w) =>
        w.fixPushes === 0
          ? "–"
          : `${w.guardPushes} / ${w.fixPushes} (${Math.round((w.guardPushes / w.fixPushes) * 100)}%)`,
    },
  ];
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        Is it converging?
      </Text>
      <Text as="p" variant="caption" className="text-muted-foreground">
        Fewer new causes, fewer fixes coming back and more fixes that land a
        guard mean problems are being removed as a class rather than patched one
        at a time. The first and current weeks are partial.
        {sb.convergenceKnownFrom === null
          ? " New causes and fixes are counted from today on."
          : ` New causes and fixes are counted from the week of ${sb.convergenceKnownFrom}; before it, report rows were already swept (–).`}
      </Text>
      <Scroll axis="x">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b text-left text-caption text-muted-foreground">
              <th className="px-sm py-xs font-medium">Week of</th>
              {sb.weeks.map((w) => (
                <th key={w.week} className="px-sm py-xs text-right font-medium">
                  {shortDay(w.week)}
                  {w.days < 7 ? ` (${w.days}d)` : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.label}
                className="border-b border-border/50"
                title={r.what}
              >
                <td className="px-sm py-xs text-foreground">{r.label}</td>
                {sb.weeks.map((w) => (
                  <td
                    key={w.week}
                    className="px-sm py-xs text-right tabular-nums"
                  >
                    {r.value(w)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      <FixesHold sb={sb} />
    </Stack>
  );
}

/** Do fixes hold, per report kind: landed per week, and how many came back. */
function FixesHold({ sb }: { sb: Scoreboard }) {
  if (sb.fixKinds.length === 0) return null;
  const cell = (landed: number | null, back: number | null) =>
    landed === null || back === null
      ? "–"
      : landed === 0
        ? "0"
        : `${back} / ${landed}`;
  return (
    <Stack gap="xs">
      <Text as="div" variant="label" className="text-foreground">
        Do fixes hold? Came back / landed, by report kind
      </Text>
      <Scroll axis="x">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b text-left text-caption text-muted-foreground">
              <th className="px-sm py-xs font-medium">Kind</th>
              <th className="px-sm py-xs text-right font-medium">Came back</th>
              {sb.weeks.map((w) => (
                <th key={w.week} className="px-sm py-xs text-right font-medium">
                  {shortDay(w.week)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sb.fixKinds.map((k) => (
              <tr key={k.kind} className="border-b border-border/50">
                <td className="px-sm py-xs text-foreground">{k.kind}</td>
                <td className="px-sm py-xs text-right tabular-nums">
                  {k.cameBack} / {k.landed}
                  {k.landed > 0
                    ? ` (${Math.round((k.cameBack / k.landed) * 100)}%)`
                    : ""}
                </td>
                {k.weeks.map((w) => (
                  <td
                    key={w.week}
                    className="px-sm py-xs text-right tabular-nums"
                  >
                    {cell(w.landed, w.cameBack)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </Stack>
  );
}
