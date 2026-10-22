import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { costSessionsDaily, type CostSessionDay } from "../../shared/values";
import {
  avgPerConversation,
  type AvgPerConversationPoint as Point,
} from "../../shared/derive";
import { formatUsd, formatUsdCompact, formatTokensCompact } from "../../core";
import { useScope } from "./use-scope";

const FAMILY_PALETTE: Record<string, string> = {
  opus: "#7c3aed",
  sonnet: "#2563eb",
  haiku: "#16a34a",
};
const FALLBACK_PALETTE = ["#dc2626", "#f59e0b", "#0891b2", "#db2777"];

function colorFor(family: string, idx: number): string {
  return (
    FAMILY_PALETTE[family] ??
    FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length] ??
    "#64748b"
  );
}

function flattenCost(
  points: readonly Point[],
  families: readonly string[],
): Record<string, number | null>[] {
  return points.map((p) => {
    const row: Record<string, number | null> = {
      date: p.date as unknown as number,
      rolling7Cost: p.rolling7Cost,
    };
    for (const fam of families) {
      row[fam] = p.byFamily[fam]?.avgCost ?? 0;
      row[`r7_${fam}`] = p.rolling7ByFamily[fam]?.cost ?? null;
    }
    return row;
  });
}

function flattenTokens(
  points: readonly Point[],
  families: readonly string[],
): Record<string, number | null>[] {
  return points.map((p) => {
    const row: Record<string, number | null> = {
      date: p.date as unknown as number,
      rolling7Tokens: p.rolling7Tokens,
    };
    for (const fam of families) {
      row[fam] = p.byFamily[fam]?.avgTokens ?? 0;
      row[`r7_${fam}`] = p.rolling7ByFamily[fam]?.tokens ?? null;
    }
    return row;
  });
}

export function AvgCostPerConversationChart() {
  const { scope } = useScope();
  // The same tuple as the sessions-per-day chart: the averages are derived here.
  const sessions = useLive(costSessionsDaily, { scope });
  return (
    <LiveChart
      read={sessions}
      subject="the sessions per day"
      size="content"
      isEmpty={(d) => d.days.length === 0}
      emptyText="No sessions recorded yet."
    >
      {(d) => <AvgCostBody days={d.days} families={d.families} />}
    </LiveChart>
  );
}

function AvgCostBody({
  days,
  families,
}: {
  days: readonly CostSessionDay[];
  families: readonly string[];
}) {
  const points = avgPerConversation(days, families);
  const costRows = flattenCost(points, families);
  const tokenRows = flattenTokens(points, families);

  return (
    <Stack gap="xl">
      <Stack gap="md">
        <Text
          as="h3"
          variant="caption"
          className="font-medium text-muted-foreground"
        >
          Avg cost / conversation by model
        </Text>
        <div className="h-56 w-full">
          <>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={costRows}
                margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
              >
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="date" {...axisProps} minTickGap={32} />
                <YAxis
                  {...axisProps}
                  width={56}
                  tickFormatter={formatUsdCompact}
                />
                <Tooltip
                  isAnimationActive={false}
                  contentStyle={tooltipContentStyle}
                  labelStyle={tooltipLabelStyle}
                  cursor={barCursor}
                  formatter={(value: number, name: string) => {
                    if (name === "rolling7Cost")
                      return [formatUsd(value), "total 7d avg"];
                    if (name.endsWith(" 7d avg"))
                      return [formatUsd(value), name];
                    return [formatUsd(value), name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {families.map((fam, i) => (
                  <Bar
                    key={fam}
                    dataKey={fam}
                    name={fam}
                    stackId="cost"
                    fill={colorFor(fam, i)}
                    isAnimationActive={false}
                  />
                ))}
                {families.map((fam, i) => (
                  <Line
                    key={`r7_${fam}`}
                    type="monotone"
                    dataKey={`r7_${fam}`}
                    name={`${fam} 7d avg`}
                    stroke={colorFor(fam, i)}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                    connectNulls
                    legendType="none"
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="rolling7Cost"
                  name="total 7d avg"
                  stroke="var(--foreground)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </>
        </div>
      </Stack>

      <Stack gap="md">
        <Text
          as="h3"
          variant="caption"
          className="font-medium text-muted-foreground"
        >
          Avg tokens / conversation by model
        </Text>
        <div className="h-56 w-full">
          <>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={tokenRows}
                margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
              >
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="date" {...axisProps} minTickGap={32} />
                <YAxis
                  {...axisProps}
                  width={56}
                  tickFormatter={formatTokensCompact}
                />
                <Tooltip
                  isAnimationActive={false}
                  contentStyle={tooltipContentStyle}
                  labelStyle={tooltipLabelStyle}
                  cursor={barCursor}
                  formatter={(value: number, name: string) => {
                    if (name === "rolling7Tokens")
                      return [yAxisFormatter(value), "7-day avg"];
                    return [yAxisFormatter(value), name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {families.map((fam, i) => (
                  <Bar
                    key={fam}
                    dataKey={fam}
                    name={fam}
                    stackId="tokens"
                    fill={colorFor(fam, i)}
                    isAnimationActive={false}
                  />
                ))}
                {families.map((fam, i) => (
                  <Line
                    key={`r7_${fam}`}
                    type="monotone"
                    dataKey={`r7_${fam}`}
                    name={`${fam} 7d avg`}
                    stroke={colorFor(fam, i)}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                    connectNulls
                    legendType="none"
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="rolling7Tokens"
                  name="total 7d avg"
                  stroke="var(--foreground)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </>
        </div>
      </Stack>
    </Stack>
  );
}
