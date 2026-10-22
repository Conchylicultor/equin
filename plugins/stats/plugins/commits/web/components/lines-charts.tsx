import { useMemo, useState } from "react";
import { useConfig } from "@plugins/config_v2/web";
import { useShowEmptyDays } from "@plugins/stats/web";
import { commitsConfig } from "../../shared/config";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  SegmentedControl,
  ToggleChip,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  commitsLines,
  commitsLinesByExt,
  type CommitBucket,
} from "../../shared";
import { LiveChart } from "./live-chart";
import {
  axisProps,
  barCursor,
  fillGaps,
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipNumberFormatter,
  yAxisFormatter,
} from "./chart-primitives";
import { ExcludedPathToggles } from "./excluded-path-toggles";

const ADDED_COLOR = "var(--chart-added, #16a34a)";
const REMOVED_COLOR = "var(--chart-removed, #dc2626)";
const NET_COLOR = "var(--chart-net, #2563eb)";

const EXT_PALETTE = [
  "#6366f1",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#3b82f6",
  "#8b5cf6",
  "#f97316",
  "#14b8a6",
  "#ec4899",
  "#84cc16",
];
const MAX_EXT = EXT_PALETTE.length;
const OTHER_KEY = "other";
const OTHER_COLOR = "#94a3b8";

type SeriesKey = "added" | "removed" | "net";

function useToggleable() {
  const [hidden, setHidden] = useState<Record<SeriesKey, boolean>>({
    added: false,
    removed: false,
    net: false,
  });
  const onLegendClick = (e: any) => {
    const k = e?.dataKey as SeriesKey | undefined;
    if (k === "added" || k === "removed" || k === "net") {
      setHidden((h) => ({ ...h, [k]: !h[k] }));
    }
  };
  const legendFormatter = (value: string, entry: any) => {
    const k = entry?.dataKey as SeriesKey | undefined;
    const isHidden = k ? hidden[k] : false;
    return (
      <span
        style={{
          color: isHidden ? "var(--muted-foreground)" : "var(--foreground)",
          textDecoration: isHidden ? "line-through" : "none",
          cursor: "pointer",
        }}
      >
        {value}
      </span>
    );
  };
  return { hidden, onLegendClick, legendFormatter };
}

interface LinesPoint {
  x: string;
  added: number;
  removed: number;
}

export function CumulativeLinesChart({ dedup }: { dedup?: boolean }) {
  const read = useLive(commitsLines, {
    series: { kind: "cumulative" },
    dedup: dedup ?? false,
  });
  return (
    <LiveChart
      read={read}
      subject="the lines changed"
      isEmpty={(d) => d.points.length === 0}
      emptyText="No commits yet."
    >
      {({ points }) => <CumulativeLinesBody rawPoints={points} />}
    </LiveChart>
  );
}

function CumulativeLinesBody({ rawPoints }: { rawPoints: LinesPoint[] }) {
  const { showEmptyDays } = useShowEmptyDays();
  const { hidden, onLegendClick, legendFormatter } = useToggleable();
  const points = useMemo(() => {
    const filled = showEmptyDays
      ? fillGaps(rawPoints, "x", "day", "carry")
      : rawPoints;
    return filled.map((p) => ({
      x: p.x,
      added: p.added,
      removed: -p.removed,
      net: p.added - p.removed,
    }));
  }, [rawPoints, showEmptyDays]);
  return (
    <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
        <XAxis dataKey="x" {...axisProps} minTickGap={32} />
            <YAxis
              {...axisProps}
              allowDecimals={false}
              width={48}
              tickFormatter={yAxisFormatter}
            />
            <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={lineCursor}
              formatter={(value: number, name: string) => [
                tooltipNumberFormatter(Math.abs(value)),
                name,
              ]}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              onClick={onLegendClick}
              formatter={legendFormatter}
            />
            <Area
              type="monotone"
              dataKey="added"
              name="Added"
              stroke={ADDED_COLOR}
              fill={ADDED_COLOR}
              fillOpacity={0.2}
              strokeWidth={2}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.added}
            />
            <Area
              type="monotone"
              dataKey="removed"
              name="Removed"
              stroke={REMOVED_COLOR}
              fill={REMOVED_COLOR}
              fillOpacity={0.2}
              strokeWidth={2}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.removed}
            />
            <Line
              type="monotone"
              dataKey="net"
              name="Net"
              stroke={NET_COLOR}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.net}
            />
          </ComposedChart>
    </ResponsiveContainer>
  );
}

const BUCKETS: { id: CommitBucket; label: string }[] = [
  { id: "hour", label: "Hour" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

export function LinesRateChart({
  bucket,
  dedup,
}: {
  bucket: CommitBucket;
  dedup?: boolean;
}) {
  const read = useLive(commitsLines, {
    series: { kind: "rate", bucket },
    dedup: dedup ?? false,
  });
  return (
    <LiveChart
      read={read}
      subject="the lines changed"
      isEmpty={(d) => d.points.length === 0}
      emptyText="No commits yet."
    >
      {({ points }) => <LinesRateBody rawPoints={points} bucket={bucket} />}
    </LiveChart>
  );
}

function LinesRateBody({
  rawPoints,
  bucket,
}: {
  rawPoints: LinesPoint[];
  bucket: CommitBucket;
}) {
  const { showEmptyDays } = useShowEmptyDays();
  const { hidden, onLegendClick, legendFormatter } = useToggleable();
  const points = useMemo(() => {
    const filled = showEmptyDays ? fillGaps(rawPoints, "x", bucket) : rawPoints;
    return filled.map((p) => ({ ...p, removed: -p.removed }));
  }, [rawPoints, showEmptyDays, bucket]);

  return (
    <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={points}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
            stackOffset="sign"
          >
            <CartesianGrid {...gridProps} />
        <XAxis dataKey="x" {...axisProps} minTickGap={32} />
            <YAxis
              {...axisProps}
              allowDecimals={false}
              width={48}
              tickFormatter={yAxisFormatter}
            />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={barCursor}
              formatter={(value: number, name: string) => [
                tooltipNumberFormatter(Math.abs(value)),
                name,
              ]}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              onClick={onLegendClick}
              formatter={legendFormatter}
            />
            <Bar
              dataKey="added"
              name="Added"
              stackId="lines"
              fill={ADDED_COLOR}
              isAnimationActive={false}
              hide={hidden.added}
            />
            <Bar
              dataKey="removed"
              name="Removed"
              stackId="lines"
              fill={REMOVED_COLOR}
              isAnimationActive={false}
              hide={hidden.removed}
            />
          </BarChart>
    </ResponsiveContainer>
  );
}

// --- Breakdown by extension ---

interface ByExtPoint {
  x: string;
  byExt: Record<string, { added: number; removed: number }>;
}

function topExtensions(points: ByExtPoint[]): string[] {
  const totals = new Map<string, number>();
  for (const p of points) {
    for (const [ext, s] of Object.entries(p.byExt)) {
      totals.set(ext, (totals.get(ext) ?? 0) + s.added + s.removed);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXT)
    .map(([ext]) => ext);
}

function flattenByExt(
  points: ByExtPoint[],
  exts: string[],
): Record<string, string | number>[] {
  const extSet = new Set(exts);
  return points.map((p) => {
    const row: Record<string, string | number> = { x: p.x };
    let otherNet = 0;
    for (const [ext, s] of Object.entries(p.byExt)) {
      const net = s.added - s.removed;
      if (extSet.has(ext)) {
        row[ext] = Number(row[ext] ?? 0) + net;
      } else {
        otherNet += net;
      }
    }
    if (otherNet !== 0) row[OTHER_KEY] = Number(row[OTHER_KEY] ?? 0) + otherNet;
    return row;
  });
}

function extColor(ext: string): string {
  if (ext === OTHER_KEY) return OTHER_COLOR;
  let hash = 0;
  for (let i = 0; i < ext.length; i++)
    hash = (hash * 31 + ext.charCodeAt(i)) >>> 0;
  return EXT_PALETTE[hash % EXT_PALETTE.length] ?? OTHER_COLOR;
}

export function CumulativeLinesBreakdownChart({ dedup }: { dedup?: boolean }) {
  const read = useLive(commitsLinesByExt, {
    series: { kind: "cumulative" },
    dedup: dedup ?? false,
  });
  return (
    <LiveChart
      read={read}
      subject="the lines changed"
      isEmpty={(d) => d.points.length === 0}
      emptyText="No commits yet."
    >
      {({ points }) => <CumulativeLinesBreakdownBody points={points} />}
    </LiveChart>
  );
}

function CumulativeLinesBreakdownBody({ points }: { points: ByExtPoint[] }) {
  const { showEmptyDays } = useShowEmptyDays();
  const exts = useMemo(() => topExtensions(points), [points]);
  const rawFlat = useMemo(() => flattenByExt(points, exts), [points, exts]);
  const flatPoints = useMemo(
    () => (showEmptyDays ? fillGaps(rawFlat, "x", "day", "carry") : rawFlat),
    [rawFlat, showEmptyDays],
  );
  const allKeys = exts.includes(OTHER_KEY)
    ? exts
    : [
        ...new Set([
          ...exts,
          ...(flatPoints.some((p) => OTHER_KEY in p) ? [OTHER_KEY] : []),
        ]),
      ];

  return (
    <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={flatPoints}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
        <XAxis dataKey="x" {...axisProps} minTickGap={32} />
            <YAxis
              {...axisProps}
              allowDecimals={false}
              width={48}
              tickFormatter={yAxisFormatter}
            />
            <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={lineCursor}
              formatter={(value: number, name: string) => [
                tooltipNumberFormatter(value),
                name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {allKeys.map((ext) => (
              <Area
                key={ext}
                type="monotone"
                dataKey={ext}
                name={ext}
                stackId="ext"
                stroke={extColor(ext)}
                fill={extColor(ext)}
                fillOpacity={0.7}
                strokeWidth={1}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
    </ResponsiveContainer>
  );
}

export function LinesRateBreakdownChart({
  bucket,
  dedup,
}: {
  bucket: CommitBucket;
  dedup?: boolean;
}) {
  const read = useLive(commitsLinesByExt, {
    series: { kind: "rate", bucket },
    dedup: dedup ?? false,
  });
  return (
    <LiveChart
      read={read}
      subject="the lines changed"
      isEmpty={(d) => d.points.length === 0}
      emptyText="No commits yet."
    >
      {({ points }) => (
        <LinesRateBreakdownBody points={points} bucket={bucket} />
      )}
    </LiveChart>
  );
}

function LinesRateBreakdownBody({
  points,
  bucket,
}: {
  points: ByExtPoint[];
  bucket: CommitBucket;
}) {
  const { showEmptyDays } = useShowEmptyDays();
  const exts = useMemo(() => topExtensions(points), [points]);
  const rawFlat = useMemo(() => flattenByExt(points, exts), [points, exts]);
  const flatPoints = useMemo(
    () => (showEmptyDays ? fillGaps(rawFlat, "x", bucket) : rawFlat),
    [rawFlat, showEmptyDays, bucket],
  );
  const hasOther = flatPoints.some((p) => OTHER_KEY in p);
  const allKeys = hasOther ? [...exts, OTHER_KEY] : exts;

  return (
    <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={flatPoints}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
            stackOffset="sign"
          >
            <CartesianGrid {...gridProps} />
        <XAxis dataKey="x" {...axisProps} minTickGap={32} />
            <YAxis
              {...axisProps}
              allowDecimals={false}
              width={48}
              tickFormatter={yAxisFormatter}
            />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={barCursor}
              formatter={(value: number, name: string) => [
                tooltipNumberFormatter(value),
                name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {allKeys.map((ext) => (
              <Bar
                key={ext}
                dataKey={ext}
                name={ext}
                stackId="ext"
                fill={extColor(ext)}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
    </ResponsiveContainer>
  );
}

export function LinesChartsSection() {
  const [byType, setByType] = useState(false);
  const [bucket, setBucket] = useState<CommitBucket>("day");
  // The lines values read the excluded paths from server config and recompute
  // when it changes, so a toggle needs no refetch here.
  const { filterRebases } = useConfig(commitsConfig);

  return (
    <Stack gap="xl">
      <Stack direction="row" gap="lg" align="center" justify="between">
        <ExcludedPathToggles dense />
        <ToggleChip
          active={byType}
          onClick={() => setByType((v) => !v)}
          className={rigidClass()}
        >
          By type
        </ToggleChip>
      </Stack>
      <Stack gap="md">
        <Text
          as="h3"
          variant="caption"
          className="font-medium text-muted-foreground"
        >
          Over time
        </Text>
        {byType ? (
          <CumulativeLinesBreakdownChart dedup={filterRebases} />
        ) : (
          <CumulativeLinesChart dedup={filterRebases} />
        )}
      </Stack>
      <Stack gap="md">
        <Text
          as="h3"
          variant="caption"
          className="font-medium text-muted-foreground"
        >
          Per period
        </Text>
        {byType ? (
          <LinesRateBreakdownChart bucket={bucket} dedup={filterRebases} />
        ) : (
          <LinesRateChart bucket={bucket} dedup={filterRebases} />
        )}
        <SegmentedControl
          options={BUCKETS}
          value={bucket}
          onChange={setBucket}
        />
      </Stack>
    </Stack>
  );
}
