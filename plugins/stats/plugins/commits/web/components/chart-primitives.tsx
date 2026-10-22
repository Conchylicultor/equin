import type { ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/**
 * A chart's empty gate: `emptyText` (what this chart has none of — "No pushes
 * yet.") when there is nothing to plot, else the chart. Loading and failure
 * are not its business: a live read is framed by `LiveChart`, which renders
 * those and passes only a ready answer through here.
 */
export function ChartState({
  empty,
  emptyText,
  children,
}: {
  empty: boolean;
  emptyText: string;
  children: ReactNode;
}) {
  if (empty)
    return (
      <Text as="div" variant="body" className="text-muted-foreground">
        {emptyText}
      </Text>
    );
  return <>{children}</>;
}

export const axisProps = {
  stroke: "var(--muted-foreground)",
  tick: { fontSize: 11 },
} as const;

const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const yAxisFormatter = (v: number) => compactFormatter.format(v);

const numberFormatter = new Intl.NumberFormat();
export const tooltipNumberFormatter = (v: number) => numberFormatter.format(v);

export const tooltipContentStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--popover-foreground)",
  fontSize: 12,
} as const;

export const tooltipLabelStyle = {
  color: "var(--foreground)",
  fontWeight: 500,
} as const;

export const lineCursor = {
  stroke: "var(--muted-foreground)",
  strokeDasharray: "3 3" as const,
};

export const barCursor = { fill: "var(--muted)", opacity: 0.3 };

export const gridProps = {
  strokeDasharray: "3 3",
  stroke: "var(--border)",
} as const;

type BucketType = "hour" | "day" | "week" | "month" | "year";

function nextBucket(date: Date, bucket: BucketType): Date {
  const d = new Date(date);
  switch (bucket) {
    case "hour":
      d.setUTCHours(d.getUTCHours() + 1);
      break;
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d;
}

function formatBucket(date: Date, bucket: BucketType): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  switch (bucket) {
    case "hour":
      return `${y}-${m}-${day} ${String(date.getUTCHours()).padStart(2, "0")}:00`;
    case "day":
      return `${y}-${m}-${day}`;
    case "week":
      return `${y}-${m}-${day}`;
    case "month":
      return `${y}-${m}`;
    case "year":
      return `${y}`;
  }
}

function parseBucketDate(key: string, bucket: BucketType): Date {
  switch (bucket) {
    case "hour": {
      const [datePart, timePart] = key.split(" ");
      const [y, m, d] = datePart!.split("-").map(Number);
      const h = parseInt(timePart!, 10);
      return new Date(Date.UTC(y!, m! - 1, d!, h));
    }
    case "day":
    case "week": {
      const [y, m, d] = key.split("-").map(Number);
      return new Date(Date.UTC(y!, m! - 1, d!));
    }
    case "month": {
      const [y, m] = key.split("-").map(Number);
      return new Date(Date.UTC(y!, m! - 1, 1));
    }
    case "year":
      return new Date(Date.UTC(parseInt(key, 10), 0, 1));
  }
}

export function fillGaps<T extends Record<string, any>>(
  points: T[],
  dateKey: string,
  bucket: BucketType,
  mode: "zero" | "carry" = "zero",
): T[] {
  if (points.length < 2) return points;
  const first = points[0]![dateKey] as string;
  const last = points[points.length - 1]![dateKey] as string;
  const lookup = new Map<string, T>();
  for (const p of points) lookup.set(p[dateKey] as string, p);

  const result: T[] = [];
  let current = parseBucketDate(first, bucket);
  const end = parseBucketDate(last, bucket);
  let lastPoint = points[0]!;

  while (current <= end) {
    const key = formatBucket(current, bucket);
    const existing = lookup.get(key);
    if (existing) {
      result.push(existing);
      lastPoint = existing;
    } else {
      const empty = { ...lastPoint, [dateKey]: key } as T;
      if (mode === "zero") {
        for (const k of Object.keys(empty)) {
          if (k !== dateKey && typeof empty[k] === "number") {
            (empty as any)[k] = 0;
          }
        }
      }
      result.push(empty);
    }
    current = nextBucket(current, bucket);
  }
  return result;
}
