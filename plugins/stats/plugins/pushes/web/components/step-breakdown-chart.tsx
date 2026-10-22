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
import { pushesStepBreakdown, type PushBucket } from "../../shared/values";
import { PushChartFrame } from "./push-chart-frame";
import {
  axisProps,
  barCursor,
  gridProps,
  tooltipContentStyle,
  tooltipLabelStyle,
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";

const STEP_COLORS: Record<string, string> = {
  fetch: "#6366f1",   // indigo
  rebase: "#f59e0b",  // amber
  checks: "#8b5cf6",  // violet
  push: "#06b6d4",    // cyan
  other: "#94a3b8",   // slate
};

const STEP_LABELS: Record<string, string> = {
  fetch: "Fetch",
  rebase: "Rebase",
  checks: "Checks",
  push: "Push",
  other: "Other",
};

const STEP_KEYS = ["fetch", "rebase", "checks", "push", "other"] as const;

export function StepBreakdownChart({ bucket }: { bucket: PushBucket }) {
  const result = useLive(pushesStepBreakdown, { bucket });

  return (
    <PushChartFrame
      title="Avg step duration (seconds)"
      subject="the push step breakdown"
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
                STEP_LABELS[name] ?? name,
              ]}
            />
            <Legend
              formatter={(value: string) => STEP_LABELS[value] ?? value}
            />
            {STEP_KEYS.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="a"
                fill={STEP_COLORS[key]}
                radius={
                  i === STEP_KEYS.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]
                }
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </PushChartFrame>
  );
}
