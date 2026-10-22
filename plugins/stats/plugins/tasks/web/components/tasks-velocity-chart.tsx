import { useMemo, useState } from "react";
import {
  Bar,
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
  LiveChart,
  axisProps,
  barCursor,
  fillGaps,
  gridProps,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipNumberFormatter,
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";
import { useShowEmptyDays } from "@plugins/stats/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  tasksHistory,
  velocitySeries,
  type TaskHistoryDay,
} from "../../shared";

const ADDED_COLOR = "var(--chart-active, #f59e0b)";
const COMPLETED_COLOR = "var(--chart-completed, #16a34a)";
const DROPPED_COLOR = "var(--chart-dropped, #dc2626)";
const NET_COLOR = "var(--chart-total, #2563eb)";

type SeriesKey = "added" | "completed" | "dropped" | "net";

export function TasksVelocityChart() {
  const history = useLive(tasksHistory);
  return (
    <LiveChart
      read={history}
      subject="the task history"
      isEmpty={(days) => days.length === 0}
      emptyText="No tasks yet."
    >
      {(days) => <VelocityChart days={days} />}
    </LiveChart>
  );
}

function VelocityChart({ days }: { days: readonly TaskHistoryDay[] }) {
  const { showEmptyDays } = useShowEmptyDays();
  const rawPoints = useMemo(() => velocitySeries(days), [days]);
  const points = useMemo(
    () => (showEmptyDays ? fillGaps(rawPoints, "date", "day") : rawPoints),
    [rawPoints, showEmptyDays],
  );
  const [hidden, setHidden] = useState<Record<SeriesKey, boolean>>({
    added: false,
    completed: false,
    dropped: false,
    net: false,
  });
  const onLegendClick = (e: any) => {
    const k = e?.dataKey as SeriesKey | undefined;
    if (k === "added" || k === "completed" || k === "dropped" || k === "net") {
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

  return (
    <>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          // A daily series is ~5px a day. Recharts' default 4px gap between
          // the two bar groups then leaves each bar a fraction of a pixel
          // (it only drops the gap once it no longer fits at all), so the
          // bars vanish at some history lengths.
          barGap={1}
          >
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} minTickGap={48} />
            <YAxis
              {...axisProps}
              allowDecimals={false}
              width={48}
              tickFormatter={yAxisFormatter}
            />
            <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
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
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              onClick={onLegendClick}
              formatter={legendFormatter}
            />
            <Bar
              dataKey="added"
              name="Added"
              fill={ADDED_COLOR}
              opacity={0.8}
              isAnimationActive={false}
              hide={hidden.added}
            />
            <Bar
              dataKey="completed"
              name="Completed"
              stackId="resolved"
              fill={COMPLETED_COLOR}
              opacity={0.8}
              isAnimationActive={false}
              hide={hidden.completed}
            />
            <Bar
              dataKey="dropped"
              name="Dropped/held"
              stackId="resolved"
              fill={DROPPED_COLOR}
              opacity={0.8}
              isAnimationActive={false}
              hide={hidden.dropped}
            />
            <Line
              type="monotone"
              dataKey="net"
              name="Net (resolved − added)"
              stroke={NET_COLOR}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.net}
            />
          </ComposedChart>
        </ResponsiveContainer>
    </>
  );
}
