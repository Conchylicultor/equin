import type { ReactNode } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsReport } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  chartPoints,
  stackedParts,
  type ChartPoint,
} from "../internal/chart-points";
import { previousPeriodLabel } from "../internal/format";
import type { Kpi } from "../internal/kpis";

// Chart chrome in theme tokens only — the pattern `stats/commits` established.
const axisProps = {
  stroke: "var(--muted-foreground)",
  tick: { fontSize: 11 },
} as const;
const gridProps = {
  strokeDasharray: "3 3",
  stroke: "var(--border)",
  vertical: false,
} as const;
const tooltipContentStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--popover-foreground)",
  fontSize: 12,
} as const;
const lineCursor = {
  stroke: "var(--muted-foreground)",
  strokeDasharray: "3 3",
} as const;

export function TrendChart({
  report,
  kpi,
}: {
  report: AnalyticsReport;
  kpi: Kpi;
}): ReactNode {
  const points = chartPoints(report, kpi);
  const hasPrevious = report.previous !== null;
  const stack = stackedParts(kpi, points);
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={points}
          margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
        >
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="label"
            {...axisProps}
            minTickGap={24}
            tickLine={false}
          />
          <YAxis
            {...axisProps}
            width={56}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => kpi.format(v)}
          />
          <Tooltip
            isAnimationActive={false}
            contentStyle={tooltipContentStyle}
            cursor={lineCursor}
            formatter={(value: number) => kpi.format(value)}
            // Stacked, the parts are the series: the total joins the label.
            labelFormatter={(label: string, payload) => {
              const total = (payload[0]?.payload as ChartPoint | undefined)
                ?.current;
              return stack && total != null
                ? `${label} · ${kpi.format(total)} ${kpi.label.toLowerCase()}`
                : label;
            }}
          />
          <Legend
            verticalAlign="top"
            align="left"
            height={28}
            iconType="plainline"
            wrapperStyle={{ fontSize: 12 }}
          />
          {hasPrevious && (
            <Line
              name={previousPeriodLabel(report.range)}
              dataKey="previous"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {stack ? (
            // The parts fill up to the total, first part at the bottom.
            stack.map((part) => (
              <Area
                key={part.id}
                name={part.label}
                dataKey={(p: ChartPoint) => p.parts[part.id]}
                stackId="kpi"
                type="linear"
                stroke={part.color}
                strokeWidth={2}
                fill={part.color}
                fillOpacity={0.25}
                dot={false}
                activeDot={{ r: 4 }}
                legendType="plainline"
                isAnimationActive={false}
              />
            ))
          ) : (
            <Line
              name={kpi.label}
              dataKey="current"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
