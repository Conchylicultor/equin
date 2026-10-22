import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useShowEmptyDays } from "@plugins/stats/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { commitsCounts, type CommitBucket } from "../../shared";
import { LiveChart } from "./live-chart";
import {
  axisProps,
  barCursor,
  fillGaps,
  gridProps,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipNumberFormatter,
  yAxisFormatter,
} from "./chart-primitives";

const BUCKETS: { id: CommitBucket; label: string }[] = [
  { id: "hour", label: "Hour" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

interface Point {
  x: string;
  count: number;
}

export function CommitsRateChart({ dedup }: { dedup?: boolean }) {
  const [bucket, setBucket] = useState<CommitBucket>("day");
  const read = useLive(commitsCounts, {
    series: { kind: "rate", bucket },
    dedup: dedup ?? false,
  });
  return (
    <Stack gap="md">
      <LiveChart
        read={read}
        subject="the commit counts"
        isEmpty={(d) => d.points.length === 0}
        emptyText="No commits yet."
      >
        {({ points }) => <CommitsRateBody rawPoints={points} bucket={bucket} />}
      </LiveChart>
      <SegmentedControl options={BUCKETS} value={bucket} onChange={setBucket} />
    </Stack>
  );
}

function CommitsRateBody({
  rawPoints,
  bucket,
}: {
  rawPoints: Point[];
  bucket: CommitBucket;
}) {
  const valueLabel = "Commits";
  const { showEmptyDays } = useShowEmptyDays();
  const points = useMemo(
    () => (showEmptyDays ? fillGaps(rawPoints, "x", bucket) : rawPoints),
    [rawPoints, showEmptyDays, bucket],
  );
  return (
    <ResponsiveContainer width="100%" height="100%">
            <BarChart
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
              <Tooltip
                isAnimationActive={false}
                contentStyle={tooltipContentStyle}
                labelStyle={tooltipLabelStyle}
                cursor={barCursor}
                formatter={(value: number) => [
                  tooltipNumberFormatter(value),
                  valueLabel,
                ]}
              />
              <Bar
                dataKey="count"
                fill="var(--primary)"
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
    </ResponsiveContainer>
  );
}
