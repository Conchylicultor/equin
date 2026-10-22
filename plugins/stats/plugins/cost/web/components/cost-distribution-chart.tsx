import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  LiveChart,
  axisProps,
  barCursor,
  gridProps,
  tooltipContentStyle,
  tooltipLabelStyle,
} from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { costDistribution } from "../../shared/values";
import { useScope } from "./use-scope";

export function CostDistributionChart() {
  const { scope } = useScope();
  const distribution = useLive(costDistribution, { scope });
  return (
    <LiveChart
      read={distribution}
      subject="the cost distribution"
      isEmpty={(d) => d.buckets.every((b) => b.count === 0)}
      emptyText="No sessions recorded yet."
    >
      {({ buckets }) => (
        <>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={buckets}
              margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
            >
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="label" {...axisProps} />
              <YAxis {...axisProps} width={40} allowDecimals={false} />
              <Tooltip
                isAnimationActive={false}
                contentStyle={tooltipContentStyle}
                labelStyle={tooltipLabelStyle}
                cursor={barCursor}
                formatter={(value: number) => [value, "conversations"]}
              />
              <Bar
                dataKey="count"
                name="Conversations"
                fill="#2563eb"
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </LiveChart>
  );
}
