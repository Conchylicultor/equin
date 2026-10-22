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
import {
  LiveChart,
  axisProps,
  fillGaps,
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
} from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { costDaily, type CostDay } from "../../shared/values";
import { cumulativeCost } from "../../shared/derive";
import { useShowEmptyDays } from "@plugins/stats/web";
import { formatUsd, formatUsdCompact } from "../../core";
import { useScope } from "./use-scope";

export function CumulativeCostChart() {
  const { scope } = useScope();
  // The same tuple as the daily chart: one read, the running sum derived here.
  const daily = useLive(costDaily, { scope });
  return (
    <LiveChart
      read={daily}
      subject="the daily cost"
      isEmpty={(d) => d.days.length === 0}
      emptyText="No cost recorded yet."
    >
      {(d) => <CumulativeCostBody days={d.days} />}
    </LiveChart>
  );
}

function CumulativeCostBody({ days }: { days: readonly CostDay[] }) {
  const { showEmptyDays } = useShowEmptyDays();
  const points = useMemo(() => {
    const raw = cumulativeCost(days);
    return showEmptyDays ? fillGaps(raw, "date", "day", "carry") : raw;
  }, [days, showEmptyDays]);
  return (
    <>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={points}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} minTickGap={32} />
            <YAxis {...axisProps} width={56} tickFormatter={formatUsdCompact} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={lineCursor}
              formatter={(value: number) => [formatUsd(value), "Cumulative"]}
            />
            <Line
              type="monotone"
              dataKey="cost"
              stroke="var(--primary)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
    </>
  );
}
