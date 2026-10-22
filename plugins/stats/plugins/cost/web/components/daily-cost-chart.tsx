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
import { costDaily, type CostDay } from "../../shared/values";
import { useShowEmptyDays } from "@plugins/stats/web";
import { formatUsd, formatUsdCompact } from "../../core";
import { useScope } from "./use-scope";

// Family-based palette; specific revisions (opus-4-7, sonnet-4-6, …)
// inherit the family color so the chart stays readable as versions roll over.
const FAMILY_PALETTE: Record<string, string> = {
  opus: "#7c3aed",
  sonnet: "#2563eb",
  haiku: "#16a34a",
};

const FALLBACK_PALETTE = [
  "#dc2626",
  "#f59e0b",
  "#0891b2",
  "#db2777",
  "#65a30d",
];

function colorFor(model: string, idx: number): string {
  for (const [fam, color] of Object.entries(FAMILY_PALETTE)) {
    if (model.startsWith(fam)) return color;
  }
  return FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length] ?? "#64748b";
}

export function DailyCostChart() {
  const { scope } = useScope();
  const daily = useLive(costDaily, { scope });
  return (
    <LiveChart
      read={daily}
      subject="the daily cost"
      size="lg"
      isEmpty={(d) => d.days.length === 0}
      emptyText="No cost recorded yet."
    >
      {(d) => <DailyCostBody days={d.days} models={d.models} />}
    </LiveChart>
  );
}

function DailyCostBody({
  days,
  models,
}: {
  days: readonly CostDay[];
  models: readonly string[];
}) {
  const { showEmptyDays } = useShowEmptyDays();
  const rows = useMemo(() => {
    const raw = days.map((p) => ({ date: p.date, ...p.byModel }));
    return showEmptyDays ? fillGaps(raw, "date", "day") : raw;
  }, [days, showEmptyDays]);

  return (
    <>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} minTickGap={32} />
            <YAxis {...axisProps} width={56} tickFormatter={formatUsdCompact} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={barCursor}
              formatter={(value: number, name: string) => [
                formatUsd(value),
                name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {models.map((m, i) => (
              <Bar
                key={m}
                dataKey={m}
                name={m}
                stackId="cost"
                fill={colorFor(m, i)}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
    </>
  );
}
