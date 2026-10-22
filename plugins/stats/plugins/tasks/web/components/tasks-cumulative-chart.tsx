import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
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
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipNumberFormatter,
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  cumulativeSeries,
  tasksHistory,
  type TaskHistoryDay,
} from "../../shared";

const TOTAL_COLOR = "var(--chart-total, #2563eb)";
const ACTIVE_COLOR = "var(--chart-active, #f59e0b)";
const COMPLETED_COLOR = "var(--chart-completed, #16a34a)";
const DROPPED_COLOR = "var(--chart-dropped, #dc2626)";

type SeriesKey = "total" | "active" | "completed" | "dropped";

export function TasksCumulativeChart() {
  const history = useLive(tasksHistory);
  return (
    <LiveChart
      read={history}
      subject="the task history"
      isEmpty={(days) => days.length === 0}
      emptyText="No tasks yet."
    >
      {(days) => <CumulativeChart days={days} />}
    </LiveChart>
  );
}

function CumulativeChart({ days }: { days: readonly TaskHistoryDay[] }) {
  const points = useMemo(() => cumulativeSeries(days), [days]);
  const [hidden, setHidden] = useState<Record<SeriesKey, boolean>>({
    total: false,
    active: false,
    completed: false,
    dropped: false,
  });
  const onLegendClick = (e: any) => {
    const k = e?.dataKey as SeriesKey | undefined;
    if (k === "total" || k === "active" || k === "completed" || k === "dropped") {
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
          <LineChart
            data={points}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} minTickGap={48} />
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
            <Line
              type="monotone"
              dataKey="total"
              name="Total"
              stroke={TOTAL_COLOR}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.total}
            />
            <Line
              type="monotone"
              dataKey="active"
              name="Active"
              stroke={ACTIVE_COLOR}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.active}
            />
            <Line
              type="monotone"
              dataKey="completed"
              name="Completed"
              stroke={COMPLETED_COLOR}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.completed}
            />
            <Line
              type="monotone"
              dataKey="dropped"
              name="Dropped"
              stroke={DROPPED_COLOR}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              hide={hidden.dropped}
            />
          </LineChart>
        </ResponsiveContainer>
    </>
  );
}
