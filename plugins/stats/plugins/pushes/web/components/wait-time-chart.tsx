import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLive } from "@plugins/network/plugins/live/web";
import { pushesWaitTime, type PushBucket } from "../../shared/values";
import { PushChartFrame } from "./push-chart-frame";
import {
  axisProps,
  barCursor,
  gridProps,
  tooltipContentStyle,
  tooltipLabelStyle,
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";

export function WaitTimeChart({ bucket }: { bucket: PushBucket }) {
  const result = useLive(pushesWaitTime, { bucket });

  return (
    <PushChartFrame
      title="Lock wait time (seconds)"
      subject="the push wait times"
      bucket={bucket}
      result={result}
    >
      {(points) => (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={points}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="bucket" {...axisProps} minTickGap={32} />
            <YAxis
              {...axisProps}
              allowDecimals
              width={48}
              tickFormatter={yAxisFormatter}
            />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={barCursor}
              formatter={(value: number, name: string) => [
                `${value}s`,
                name === "avg" ? "Avg wait" : "Max wait",
              ]}
            />
            <Legend
              formatter={(value: string) =>
                value === "avg" ? "Avg wait" : "Max wait"
              }
            />
            <Bar
              dataKey="avg"
              fill="var(--primary)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="max"
              fill="var(--muted-foreground)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </PushChartFrame>
  );
}
