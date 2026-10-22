import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useShowEmptyDays } from "@plugins/stats/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { commitsCounts } from "../../shared";
import { LiveChart } from "./live-chart";
import {
  axisProps,
  fillGaps,
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipNumberFormatter,
  yAxisFormatter,
} from "./chart-primitives";

interface Point {
  x: string;
  count: number;
}

export function CumulativeCommitsChart({ dedup }: { dedup?: boolean }) {
  const read = useLive(commitsCounts, {
    series: { kind: "cumulative" },
    dedup: dedup ?? false,
  });
  return (
    <LiveChart
      read={read}
      subject="the commit counts"
      isEmpty={(d) => d.points.length === 0}
      emptyText="No commits yet."
    >
      {({ points }) => <CumulativeCommitsBody rawPoints={points} />}
    </LiveChart>
  );
}

function CumulativeCommitsBody({ rawPoints }: { rawPoints: Point[] }) {
  const valueLabel = "Commits";
  const { showEmptyDays } = useShowEmptyDays();
  const points = useMemo(
    () =>
      showEmptyDays ? fillGaps(rawPoints, "x", "day", "carry") : rawPoints,
    [rawPoints, showEmptyDays],
  );
  return (
    <ResponsiveContainer width="100%" height="100%">
          <LineChart
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
              cursor={lineCursor}
              formatter={(value: number) => [
                tooltipNumberFormatter(value),
                valueLabel,
              ]}
            />
            <Line
              type="monotone"
              dataKey="count"
              stroke="var(--primary)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
    </ResponsiveContainer>
  );
}
