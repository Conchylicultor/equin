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
import { pushesThroughput, type PushBucket } from "../../shared/values";
import { PushChartFrame } from "./push-chart-frame";
import {
  axisProps,
  barCursor,
  gridProps,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipNumberFormatter,
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";

export function ThroughputChart({ bucket }: { bucket: PushBucket }) {
  const result = useLive(pushesThroughput, { bucket });

  return (
    <PushChartFrame
      title="Push throughput"
      subject="the push throughput"
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
                name === "success" ? "Success" : "Failed",
              ]}
            />
            <Legend
              formatter={(value: string) =>
                value === "success" ? "Success" : "Failed"
              }
            />
            <Bar
              dataKey="success"
              stackId="a"
              fill="#10b981"
              radius={[0, 0, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="failed"
              stackId="a"
              fill="#ef4444"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </PushChartFrame>
  );
}
