import { useCallback, useMemo, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useShowEmptyDays } from "@plugins/stats/web";
import {
  autoColorKey,
  useCategoryAvatars,
} from "@plugins/conversations/plugins/conversation-category/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { commitsCountsByCategory, type CommitBucket } from "../../shared";
import { LiveChart } from "./live-chart";
import {
  axisProps,
  barCursor,
  fillGaps,
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
  tooltipNumberFormatter,
  yAxisFormatter,
} from "./chart-primitives";

// Tailwind -400 shades as hex, matching the avatar swatch colors
const COLOR_KEY_HEX: Record<string, string> = {
  sky: "#38bdf8",
  emerald: "#34d399",
  amber: "#fbbf24",
  rose: "#fb7185",
  violet: "#a78bfa",
  indigo: "#818cf8",
  teal: "#2dd4bf",
  pink: "#f472b6",
  orange: "#fb923c",
  slate: "#94a3b8",
};
const UNKNOWN_KEY = "Unknown";
const UNKNOWN_COLOR = "#94a3b8";

// Colors come from the ITEM's own configured avatar within this category, so
// two categories can reuse the same item name without sharing a color.
function useItemColorFn(categoryId: string): (item: string) => string {
  const avatars = useCategoryAvatars(categoryId);
  return useCallback(
    (item: string): string => {
      if (item === UNKNOWN_KEY) return UNKNOWN_COLOR;
      const colorKey = avatars[item]?.color ?? autoColorKey(item);
      return COLOR_KEY_HEX[colorKey] ?? UNKNOWN_COLOR;
    },
    [avatars],
  );
}

function useToggleable() {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const onLegendClick = (e: any) => {
    const k = (e?.dataKey ?? e?.value) as string | undefined;
    if (k) setHidden((h) => ({ ...h, [k]: !h[k] }));
  };
  const legendFormatter = (value: string, entry: any) => {
    const k = (entry?.dataKey ?? entry?.value) as string | undefined;
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
  return { hidden, onLegendClick, legendFormatter };
}

interface ByItemPoint {
  x: string;
  byItem: Record<string, number>;
}

interface CategoryResponse {
  points: ByItemPoint[];
  items: string[];
}

function useOrderedKeys(data: CategoryResponse): string[] {
  return useMemo(() => {
    const { points, items } = data;
    const present = new Set<string>();
    for (const p of points) {
      for (const item of Object.keys(p.byItem)) present.add(item);
    }
    const ordered: string[] = [];
    for (const item of items) {
      if (present.has(item)) ordered.push(item);
    }
    // Items dropped from config but still stored on old conversations keep their
    // series rather than vanishing from the history.
    for (const item of present) {
      if (!ordered.includes(item)) ordered.push(item);
    }
    return ordered;
  }, [data]);
}

function flattenByItem(
  points: ByItemPoint[],
  items: string[],
): Record<string, string | number>[] {
  return points.map((p) => {
    const row: Record<string, string | number> = { x: p.x };
    for (const item of items) {
      row[item] = p.byItem[item] ?? 0;
    }
    return row;
  });
}

export function CumulativeCommitsCategoryChart({
  dedup,
  categoryId,
}: {
  dedup?: boolean;
  categoryId: string;
}) {
  const read = useLive(commitsCountsByCategory, {
    series: { kind: "cumulative" },
    dedup: dedup ?? false,
    categoryId,
  });
  return (
    <LiveChart
      read={read}
      subject="the commit counts"
      isEmpty={(d) => d.points.length === 0}
      emptyText="No commits yet."
    >
      {(data) => (
        <CumulativeCommitsCategoryBody data={data} categoryId={categoryId} />
      )}
    </LiveChart>
  );
}

function CumulativeCommitsCategoryBody({
  data,
  categoryId,
}: {
  data: CategoryResponse;
  categoryId: string;
}) {
  const { showEmptyDays } = useShowEmptyDays();
  const colorFor = useItemColorFn(categoryId);
  const { hidden, onLegendClick, legendFormatter } = useToggleable();
  const allKeys = useOrderedKeys(data);
  const flatPoints = useMemo(() => {
    const rawFlat = flattenByItem(data.points, allKeys);
    return showEmptyDays && rawFlat.length >= 2
      ? fillGaps(rawFlat, "x", "day", "carry")
      : rawFlat;
  }, [data.points, allKeys, showEmptyDays]);

  return (
    <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={flatPoints}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid {...gridProps} />
        <XAxis dataKey="x" {...axisProps} minTickGap={32} />
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
              wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
              onClick={onLegendClick}
              formatter={legendFormatter}
            />
            {allKeys.map((item) => (
              <Area
                key={item}
                type="monotone"
                dataKey={item}
                name={item}
                stackId="item"
                stroke={colorFor(item)}
                fill={colorFor(item)}
                fillOpacity={0.7}
                strokeWidth={1}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
                hide={!!hidden[item]}
              />
            ))}
          </ComposedChart>
    </ResponsiveContainer>
  );
}

const BUCKETS: { id: CommitBucket; label: string }[] = [
  { id: "hour", label: "Hour" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

export function CommitsRateCategoryChart({
  dedup,
  categoryId,
}: {
  dedup?: boolean;
  categoryId: string;
}) {
  const [bucket, setBucket] = useState<CommitBucket>("day");
  const read = useLive(commitsCountsByCategory, {
    series: { kind: "rate", bucket },
    dedup: dedup ?? false,
    categoryId,
  });
  return (
    <Stack gap="md">
      <LiveChart
        read={read}
        subject="the commit counts"
        isEmpty={(d) => d.points.length === 0}
        emptyText="No commits yet."
      >
        {(data) => (
          <CommitsRateCategoryBody
            data={data}
            categoryId={categoryId}
            bucket={bucket}
          />
        )}
      </LiveChart>
      <SegmentedControl options={BUCKETS} value={bucket} onChange={setBucket} />
    </Stack>
  );
}

function CommitsRateCategoryBody({
  data,
  categoryId,
  bucket,
}: {
  data: CategoryResponse;
  categoryId: string;
  bucket: CommitBucket;
}) {
  const { showEmptyDays } = useShowEmptyDays();
  const colorFor = useItemColorFn(categoryId);
  const { hidden, onLegendClick, legendFormatter } = useToggleable();
  const allKeys = useOrderedKeys(data);
  const flatPoints = useMemo(() => {
    const rawFlat = flattenByItem(data.points, allKeys);
    return showEmptyDays && rawFlat.length >= 2
      ? fillGaps(rawFlat, "x", bucket)
      : rawFlat;
  }, [data.points, allKeys, showEmptyDays, bucket]);

  return (
    <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={flatPoints}
              margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
            >
              <CartesianGrid {...gridProps} />
        <XAxis dataKey="x" {...axisProps} minTickGap={32} />
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
                  name,
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
                onClick={onLegendClick}
                formatter={legendFormatter}
              />
              {allKeys.map((item) => (
                <Bar
                  key={item}
                  dataKey={item}
                  name={item}
                  stackId="item"
                  fill={colorFor(item)}
                  isAnimationActive={false}
                  hide={!!hidden[item]}
                />
              ))}
            </BarChart>
    </ResponsiveContainer>
  );
}
