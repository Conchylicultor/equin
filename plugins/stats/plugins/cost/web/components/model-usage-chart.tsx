import { useMemo } from "react";
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
import {
  LiveChart,
  axisProps,
  barCursor,
  fillGaps,
  gridProps,
  tooltipContentStyle,
  tooltipLabelStyle,
} from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { costSessionsDaily, type CostSessionDay } from "../../shared/values";
import { useShowEmptyDays } from "@plugins/stats/web";
import { useScope } from "./use-scope";

const FAMILY_COLORS: Record<string, string> = {
  opus: "#7c3aed",
  sonnet: "#2563eb",
  haiku: "#16a34a",
};

const FALLBACK_COLORS = ["#dc2626", "#f59e0b", "#0891b2"];

function colorForFamily(family: string, idx: number): string {
  return (
    FAMILY_COLORS[family] ??
    FALLBACK_COLORS[idx % FALLBACK_COLORS.length] ??
    "#64748b"
  );
}

export function ModelUsageChart() {
  const { scope } = useScope();
  const sessions = useLive(costSessionsDaily, { scope });
  return (
    <LiveChart
      read={sessions}
      subject="the sessions per day"
      size="lg"
      isEmpty={(d) => d.days.length === 0}
      emptyText="No sessions recorded yet."
    >
      {(d) => <ModelUsageBody days={d.days} families={d.families} />}
    </LiveChart>
  );
}

function ModelUsageBody({
  days,
  families,
}: {
  days: readonly CostSessionDay[];
  families: readonly string[];
}) {
  const { showEmptyDays } = useShowEmptyDays();
  const rows = useMemo(() => {
    const raw = days.map((d) => {
      const byFamily: Record<string, number> = {};
      for (const f of families) byFamily[f] = d.byFamily[f]?.sessions ?? 0;
      return { date: d.date, ...byFamily };
    });
    return showEmptyDays ? fillGaps(raw, "date", "day") : raw;
  }, [days, families, showEmptyDays]);
  return (
    <>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
        >
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="date" {...axisProps} minTickGap={32} />
          <YAxis {...axisProps} width={40} allowDecimals={false} />
          <Tooltip
            isAnimationActive={false}
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            cursor={barCursor}
            formatter={(value: number, name: string) => [
              `${value} sessions`,
              name,
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {families.map((f, i) => (
            <Bar
              key={f}
              dataKey={f}
              name={f}
              stackId="sessions"
              fill={colorForFamily(f, i)}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}
