import { useMemo, type ReactElement } from "react";
import {
  CartesianGrid,
  Label,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartState,
  axisProps,
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { loadSeverity } from "@plugins/debug/plugins/slow-ops/core";
import { healthMonitorSeries } from "../../shared/resources";
import type { HealthSeries, HostSample } from "../../core";

const SAMPLE_BUCKET_MS = 10_000; // align spikes to the 10s sample grid

type ChartRow = Record<string, number>;
interface LineSpec {
  key: string;
  label: string;
  color: string;
}

// One coalesced slow-op spike line: a 10s bucket on the shared time axis, the
// worst severity in the bucket, and the op naming the worst offender (used only
// to label destructive lines).
interface SpikeMarker {
  key: string;
  x: number; // bucket time in epoch ms — same scale as the sampledAt axis
  severity: "muted" | "warning" | "destructive";
  label: string;
}

// Severity → stroke color (presentational, local to the charts).
const SEVERITY_STROKE: Record<SpikeMarker["severity"], string> = {
  muted: "var(--muted-foreground)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
};

const SEVERITY_RANK: Record<SpikeMarker["severity"], number> = {
  muted: 0,
  warning: 1,
  destructive: 2,
};

const fmtTime = (v: number): string =>
  new Date(v).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function MetricChart({
  data,
  lines,
  markers,
}: {
  data: ChartRow[];
  lines: LineSpec[];
  markers?: SpikeMarker[];
}): ReactElement {
  return (
    <div className="h-44 w-full">
      <ChartState error={null} loading={false} empty={data.length === 0}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="sampledAt"
              type="number"
              domain={["dataMin", "dataMax"]}
              {...axisProps}
              tickFormatter={fmtTime}
              minTickGap={48}
            />
            <YAxis {...axisProps} width={48} tickFormatter={yAxisFormatter} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={lineCursor}
              labelFormatter={(v) => fmtTime(Number(v))}
            />
            {/* Slow-op spike lines, drawn BEFORE the data lines so the metric
                series paint on top. The op name labels only the destructive
                lines, naming the worst offenders without cluttering the rest. */}
            {markers?.map((m) => (
              <ReferenceLine
                key={m.key}
                x={m.x}
                stroke={SEVERITY_STROKE[m.severity]}
                strokeWidth={1}
                strokeOpacity={0.7}
                ifOverflow="hidden"
              >
                {m.severity === "destructive" ? (
                  <Label
                    value={m.label}
                    position="insideTopRight"
                    angle={-90}
                    fontSize={9}
                    fill="var(--muted-foreground)"
                  />
                ) : null}
              </ReferenceLine>
            ))}
            {lines.map((l) => (
              <Line
                key={l.key}
                type="monotone"
                dataKey={l.key}
                name={l.label}
                stroke={l.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartState>
    </div>
  );
}

function ChartBlock({
  label,
  data,
  lines,
  markers,
}: {
  label: string;
  data: ChartRow[];
  lines: LineSpec[];
  markers?: SpikeMarker[];
}): ReactElement {
  return (
    <Stack gap="xs">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <MetricChart data={data} lines={lines} markers={markers} />
    </Stack>
  );
}

function BackendSection({ series }: { series: HealthSeries }): ReactElement {
  const rows = useMemo(
    () =>
      [...series.samples].sort(
        (a, b) => a.sampledAt - b.sampledAt,
      ) as unknown as ChartRow[],
    [series.samples],
  );
  // Coalesce the (potentially hundreds of) markers to the 10s sample grid: one
  // line per non-empty bucket at the bucket time, colored by the worst severity
  // in the bucket and labeled by that bucket's most-severe op. A dense storm
  // reads as a thick colored band without rendering hundreds of DOM nodes.
  const markers = useMemo<SpikeMarker[]>(() => {
    const buckets = new Map<number, SpikeMarker>();
    for (const m of series.slowOpMarkers) {
      const x =
        Math.round(m.atTime.getTime() / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS;
      const severity = loadSeverity(m.loadAvg1, m.cpuCount);
      const existing = buckets.get(x);
      if (
        !existing ||
        SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]
      ) {
        buckets.set(x, {
          key: String(x),
          x,
          severity,
          label: `${m.operationKind} ${m.operation}`,
        });
      }
    }
    return [...buckets.values()];
  }, [series.slowOpMarkers]);
  const latest = series.samples.length
    ? series.samples.reduce((a, b) => (a.sampledAt > b.sampledAt ? a : b))
    : null;
  return (
    <Stack as="section" gap="sm">
      <Stack direction="row" align="center" gap="sm">
        <SectionLabel>{series.worktree}</SectionLabel>
        {latest ? (
          <Text variant="caption" tone="muted">
            {`${latest.physFootprintMb.toFixed(0)} MB footprint · p99 ${latest.eventLoopP99Ms.toFixed(0)} ms`}
          </Text>
        ) : null}
      </Stack>
      <Grid cols={2} gap="xl">
        <ChartBlock
          label="Event-loop lag (ms)"
          data={rows}
          markers={markers}
          lines={[
            { key: "eventLoopP99Ms", label: "p99", color: "var(--primary)" },
            {
              key: "eventLoopMaxMs",
              label: "max",
              color: "var(--destructive)",
            },
          ]}
        />
        <ChartBlock
          label="Memory (MB)"
          data={rows}
          markers={markers}
          lines={[
            {
              key: "physFootprintMb",
              label: "Footprint",
              color: "var(--destructive)",
            },
            // ri_resident_size: pages physically in RAM. The gap between Footprint
            // and this line is the backend's squeezed-out (compressed/swapped)
            // bytes — the paging-victimhood signal. Optional field ⇒ gaps on
            // pre-cutover samples, like monitorMs below.
            { key: "residentMb", label: "resident", color: "var(--warning)" },
            { key: "heapUsedMb", label: "heap used", color: "var(--primary)" },
          ]}
        />
      </Grid>
      <Grid cols={2} gap="xl">
        <ChartBlock
          label="Heap growth per interval (MB)"
          data={rows}
          markers={markers}
          lines={[
            { key: "heapGrowthMb", label: "Δ heap", color: "var(--warning)" },
          ]}
        />
        {/* Monitoring self-cost: the observability subsystem's own work per 10s
            tick (everything under runWithoutProfiling) — suppressed from the
            profiler by design, so this chart is its only visibility. */}
        <ChartBlock
          label="Monitoring self-cost per interval (ops · ms)"
          data={rows}
          markers={markers}
          lines={[
            { key: "monitorOps", label: "ops", color: "var(--primary)" },
            { key: "monitorMs", label: "ms", color: "var(--warning)" },
          ]}
        />
      </Grid>
    </Stack>
  );
}

// A backend is "stale" if its newest sample is older than ~3 sample intervals —
// the sampler ticks every 10s, so >30s of silence means the loop is wedged or
// the process is gone.
const STALE_AGE_MS = 3 * SAMPLE_BUCKET_MS;

// Static description of each backend's recurring idle work, surfaced so the
// "what is this process doing while idle?" question has an answer in-pane. These
// are fixed by code, not sampled — purely informational.
const IDLE_WORK_PER_BACKEND = [
  "worker concurrency 4",
  "stuck-lock-sweeper 60s",
  "process-sampler 10s",
];
const IDLE_WORK_MAIN_ONLY = ["host-sampler 10s", "crons"];

function BackendRow({
  series,
  now,
}: {
  series: HealthSeries;
  now: number;
}): ReactElement {
  const latest = series.samples.length
    ? series.samples.reduce((a, b) => (a.sampledAt > b.sampledAt ? a : b))
    : null;
  const ageMs = latest ? now - latest.sampledAt : Infinity;
  const stale = ageMs > STALE_AGE_MS;
  const depth = latest?.heavyReadDepth ?? 0;
  return (
    <Stack direction="row" align="center" gap="sm">
      <Stack direction="row" align="center" gap="xs">
        <StatusDot colorClass={stale ? "bg-muted-foreground" : "bg-success"} />
        <Text variant="caption">{series.worktree}</Text>
      </Stack>
      <Fill>
        {latest ? (
          <Text variant="caption" tone="muted">
            <RelativeTime date={new Date(latest.sampledAt)} />
          </Text>
        ) : (
          <Text variant="caption" tone="muted">
            no samples
          </Text>
        )}
      </Fill>
      <Stack as={Rigid} direction="row" align="center" gap="sm">
        <Badge
          variant={depth > 0 ? "warning" : "muted"}
          title="Host-wide heavy-read gate queue depth"
        >
          {`heavy-read ${depth}`}
        </Badge>
      </Stack>
    </Stack>
  );
}

function BackendsSection({
  series,
  now,
}: {
  series: HealthSeries[];
  now: number;
}): ReactElement | null {
  const rows = useMemo(
    () => [...series].sort((a, b) => a.worktree.localeCompare(b.worktree)),
    [series],
  );
  if (rows.length === 0) return null;
  return (
    <Stack as="section" gap="sm">
      <SectionLabel>Backends</SectionLabel>
      <Stack gap="2xs">
        {rows.map((s) => (
          <BackendRow key={s.worktree} series={s} now={now} />
        ))}
      </Stack>
      <Text variant="caption" tone="muted">
        {`Idle work — per backend: ${IDLE_WORK_PER_BACKEND.join(", ")}; main only: ${IDLE_WORK_MAIN_ONLY.join(", ")}.`}
      </Text>
    </Stack>
  );
}

function HostSection({
  samples,
}: {
  samples: HostSample[];
}): ReactElement | null {
  const rows = useMemo(
    () =>
      [...samples].sort(
        (a, b) => a.sampledAt - b.sampledAt,
      ) as unknown as ChartRow[],
    [samples],
  );
  if (rows.length === 0) return null;
  return (
    <Stack as="section" gap="sm">
      <SectionLabel>Host</SectionLabel>
      <Grid cols={2} gap="xl">
        <ChartBlock
          label="Load average"
          data={rows}
          lines={[
            { key: "loadAvg1", label: "1m", color: "var(--primary)" },
            { key: "loadAvg5", label: "5m", color: "var(--warning)" },
          ]}
        />
        <ChartBlock
          label="Free memory (MB) · swap-out (pages/s)"
          data={rows}
          lines={[
            { key: "freeMemMb", label: "free MB", color: "var(--success)" },
            {
              key: "swapOutPagesPerSec",
              label: "swap-out/s",
              color: "var(--destructive)",
            },
          ]}
        />
        {/* Compressor thrash is the memory-pressure channel swap misses — each
            decompression is a synchronous page fault on the faulting thread. */}
        <ChartBlock
          label="Memory compressor (pages/s)"
          data={rows}
          lines={[
            {
              key: "compressionsPerSec",
              label: "compressions/s",
              color: "var(--warning)",
            },
            {
              key: "decompressionsPerSec",
              label: "decompressions/s",
              color: "var(--destructive)",
            },
          ]}
        />
      </Grid>
    </Stack>
  );
}

export function HealthMonitorPanel(): ReactElement {
  // Pushed by the server after each of its sampler ticks (every 10 s).
  const result = useLive(healthMonitorSeries);

  if (result.status === "error") {
    return (
      <Inset pad="lg">
        <ResourceErrorInline
          variant="block"
          subject="health samples"
          error={result.error}
          refetch={result.refetch}
        />
      </Inset>
    );
  }
  if (result.status === "loading") {
    return (
      <Inset pad="lg">
        <Placeholder>Loading…</Placeholder>
      </Inset>
    );
  }
  const data = result.data;

  return (
    <Inset pad="lg">
      <Stack gap="xl">
        <HostSection samples={data.hostSamples} />
        <BackendsSection series={data.series} now={data.readAtMs} />
        {data.series.length === 0 ? (
          <Placeholder>
            No health samples yet — the sampler warms up within ~10s.
          </Placeholder>
        ) : (
          data.series.map((s) => <BackendSection key={s.worktree} series={s} />)
        )}
      </Stack>
    </Inset>
  );
}
