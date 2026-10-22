import { useState } from "react";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { LiveChart } from "@plugins/stats/plugins/commits/web";
import {
  METRIC_LABELS,
  PRESSURE_DECOMPRESSIONS_PER_SEC,
  PRESSURE_FREE_MEM_MB,
  latencySummary,
  type LatencyStat,
  type LatencySummary,
  type LatencyWindow,
} from "@plugins/debug/plugins/latency-ledger/core";
import { formatCount, formatMs, formatShare } from "./format";

const WINDOWS: { id: LatencyWindow; label: string }[] = [
  { id: "1h", label: "Last hour" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
];

type Summary = LatencySummary;

export function ResponsivenessSection() {
  const [window, setWindow] = useState<LatencyWindow>("24h");
  // Live: the server's minute flush refreshes the subscribed window. A switch
  // of window is a new tuple, so it shows its loading state rather than the
  // previous window's numbers.
  const summary = useLive(latencySummary, { window });

  return (
    <Stack gap="lg">
      <Stack direction="row" align="center" justify="between" gap="md">
        <Text as="p" variant="caption" className="text-muted-foreground">
          Every page load, navigation and update is counted, not only the slow
          ones. A minute is under pressure when memory decompressions pass{" "}
          {formatCount(PRESSURE_DECOMPRESSIONS_PER_SEC)} a second, free memory
          falls under {PRESSURE_FREE_MEM_MB} MB, or the machine watcher raised
          its alarm.
        </Text>
        <SegmentedControl
          options={WINDOWS}
          value={window}
          onChange={setWindow}
        />
      </Stack>
      <LiveChart
        read={summary}
        subject="the responsiveness summary"
        size="content"
        emptyText="No measurements yet."
      >
        {(data) => <SummaryView summary={data} />}
      </LiveChart>
    </Stack>
  );
}

function SummaryView({ summary }: { summary: Summary }) {
  return (
    <Stack gap="xl">
      <Criteria summary={summary} />
      <MetricsTable summary={summary} />
      <ThreadOwners summary={summary} />
      <Slowest summary={summary} />
    </Stack>
  );
}

function Criteria({ summary }: { summary: Summary }) {
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        Exit criteria
      </Text>
      <Grid minCellWidth="14rem" gap="md">
        {summary.criteria.map((c) => (
          <div key={c.id} className="rounded-md border bg-background p-md">
            <Stack direction="row" align="center" justify="between" gap="sm">
              <Text
                as="div"
                variant="caption"
                className="text-muted-foreground"
              >
                {c.label}
              </Text>
              <Badge
                variant={
                  c.verdict === "pass"
                    ? "success"
                    : c.verdict === "fail"
                      ? "destructive"
                      : "muted"
                }
              >
                {c.verdict === "no-data" ? "no data" : c.verdict}
              </Badge>
            </Stack>
            <Text as="div" variant="title" className="text-foreground">
              {formatMs(c.valueMs)}
            </Text>
            <Text as="div" variant="caption" className="text-muted-foreground">
              target under {formatMs(c.targetMs)} · {formatCount(c.samples)}{" "}
              samples
            </Text>
          </div>
        ))}
      </Grid>
    </Stack>
  );
}

function StatCells({ stat }: { stat: LatencyStat }) {
  return (
    <>
      <td className="px-sm py-xs text-right tabular-nums">
        {formatMs(stat.p50Ms)}
      </td>
      <td className="px-sm py-xs text-right font-medium tabular-nums text-foreground">
        {formatMs(stat.p95Ms)}
      </td>
      <td className="px-sm py-xs text-right tabular-nums">
        {formatMs(stat.maxMs)}
      </td>
      <td className="px-sm py-xs text-right tabular-nums text-muted-foreground">
        {formatCount(stat.count)}
      </td>
    </>
  );
}

function MetricsTable({ summary }: { summary: Summary }) {
  const stalls = summary.threadStalls;
  const share = (s: { windows: number; over: number }) =>
    s.windows === 0 ? "–" : formatShare(s.over / s.windows);
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        Latency
      </Text>
      <Text as="p" variant="caption" className="text-muted-foreground">
        {formatCount(summary.minutes.calm)} calm minutes,{" "}
        {formatCount(summary.minutes.pressure)} under pressure,{" "}
        {formatCount(summary.minutes.slept)} left out because the machine slept.
        The serving thread stalled over {stalls.thresholdMs} ms in{" "}
        {share(stalls.calm)} of calm 10-second windows and{" "}
        {share(stalls.pressure)} of windows under pressure.
      </Text>
      <Scroll axis="x">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b text-left text-caption text-muted-foreground">
              <th className="px-sm py-xs font-medium" />
              <th className="px-sm py-xs text-center font-medium" colSpan={4}>
                Calm
              </th>
              <th className="px-sm py-xs text-center font-medium" colSpan={4}>
                Under pressure
              </th>
              <th className="px-sm py-xs text-right font-medium">Left out</th>
            </tr>
            <tr className="border-b text-left text-caption text-muted-foreground">
              <th className="px-sm py-xs font-medium">Measure</th>
              {["calm", "pressure"].map((cls) => (
                <HeaderCells key={cls} />
              ))}
              <th className="px-sm py-xs" />
            </tr>
          </thead>
          <tbody>
            {summary.metrics.map((m) => (
              <tr
                key={m.metric}
                className="border-b border-border/50"
                title={METRIC_LABELS[m.metric].what}
              >
                <td className="px-sm py-xs font-medium text-foreground">
                  {METRIC_LABELS[m.metric].label}
                </td>
                <StatCells stat={m.calm} />
                <StatCells stat={m.pressure} />
                <td className="px-sm py-xs text-right tabular-nums text-muted-foreground">
                  {formatCount(m.excluded)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </Stack>
  );
}

function HeaderCells() {
  return (
    <>
      <th className="px-sm py-xs text-right font-medium">p50</th>
      <th className="px-sm py-xs text-right font-medium">p95</th>
      <th className="px-sm py-xs text-right font-medium">worst</th>
      <th className="px-sm py-xs text-right font-medium">samples</th>
    </>
  );
}

function ThreadOwners({ summary }: { summary: Summary }) {
  const { owners, samples, busyShare } = summary.threadOwners;
  if (samples === 0) return null;
  const top = owners.slice(0, 12);
  const max = top[0]?.share ?? 1;
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        Where the serving thread&apos;s time goes
      </Text>
      <Text as="p" variant="caption" className="text-muted-foreground">
        {busyShare === null
          ? "From stack samples of the thread while it runs code"
          : `The thread was running code ${formatShare(busyShare)} of the time`}
        , {formatCount(samples)} samples. Each sample is charged to the plugin
        whose code was running, or to the npm package when no plugin frame is on
        the stack.
      </Text>
      <table className="w-full text-body">
        <tbody>
          {top.map((o) => (
            <tr key={o.owner} className="border-b border-border/50">
              <td className="px-sm py-xs text-foreground">{o.owner}</td>
              <td className="w-1/2 px-sm py-xs">
                <div className="h-2 rounded-sm bg-muted">
                  <div
                    className="h-2 rounded-sm bg-primary"
                    style={{ width: `${Math.max(1, (o.share / max) * 100)}%` }}
                  />
                </div>
              </td>
              <td className="px-sm py-xs text-right tabular-nums text-muted-foreground">
                {formatShare(o.share)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Stack>
  );
}

function Slowest({ summary }: { summary: Summary }) {
  if (summary.slowestInteractions.length === 0) return null;
  return (
    <Stack gap="sm">
      <Text as="h3" variant="subheading">
        Slowest page loads and navigations
      </Text>
      <Scroll axis="x">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b text-left text-caption text-muted-foreground">
              <th className="px-sm py-xs font-medium">Screen</th>
              <th className="px-sm py-xs font-medium">Kind</th>
              <th className="px-sm py-xs text-right font-medium">Took</th>
              <th className="px-sm py-xs text-right font-medium">
                Lists loaded
              </th>
              <th className="px-sm py-xs font-medium">Last list to arrive</th>
              <th className="px-sm py-xs font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {summary.slowestInteractions.map((i) => (
              <tr
                key={`${i.occurredAt}:${i.route}`}
                className="border-b border-border/50"
              >
                <td className="px-sm py-xs text-foreground">{i.route}</td>
                <td className="px-sm py-xs">
                  {i.kind === "page-load" ? "Page load" : "Navigation"}
                </td>
                <td className="px-sm py-xs text-right font-medium tabular-nums text-foreground">
                  {i.censored ? "over " : ""}
                  {formatMs(i.durationMs)}
                </td>
                <td className="px-sm py-xs text-right tabular-nums">
                  {formatCount(i.resourceCount)}
                </td>
                <td className="px-sm py-xs text-muted-foreground">
                  {i.lastResourceKey ?? "–"}
                </td>
                <td className="px-sm py-xs text-muted-foreground">
                  {new Date(i.occurredAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </Stack>
  );
}
