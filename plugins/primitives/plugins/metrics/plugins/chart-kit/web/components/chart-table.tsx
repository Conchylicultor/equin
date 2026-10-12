import type { ReactNode } from "react";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  formatValue,
  stackTotal,
  type ChartBucket,
  type ChartCompare,
  type ChartSeries,
  type ChartUnit,
} from "../../core";

export interface ChartTableProps {
  buckets: readonly ChartBucket[];
  series: readonly ChartSeries[];
  compare?: ChartCompare | null;
  unit?: ChartUnit;
  /** The bucket column's header. Default "Period". */
  bucketHeader?: string;
  /** Add a Total column (a stacked chart's column total). */
  total?: boolean;
  /** The scroll box's max height in px. Default 290. */
  maxHeight?: number;
  onPick?: (index: number) => void;
}

interface BucketRow {
  index: number;
  bucket: ChartBucket;
}

/**
 * The chart's table twin — every value a tooltip shows, reachable without
 * hovering. One row per bucket, newest first; a partial bucket is marked
 * "(so far)". Clicking a row picks its bucket, like clicking the chart.
 */
export function ChartTable({
  buckets,
  series,
  compare = null,
  unit = "count",
  bucketHeader = "Period",
  total = false,
  maxHeight = 290,
  onPick,
}: ChartTableProps): ReactNode {
  const rows: BucketRow[] = buckets
    .map((bucket, index) => ({ index, bucket }))
    .reverse();
  const num = (
    header: string,
    id: string,
    value: (r: BucketRow) => number | null,
  ): ColumnDef<BucketRow> => ({
    id,
    header,
    align: "end",
    value: (r) => value(r) ?? undefined,
    cell: (r) => (
      <span className="tabular-nums">{formatValue(unit, value(r))}</span>
    ),
  });
  const columns: ColumnDef<BucketRow>[] = [
    {
      id: "__bucket",
      header: bucketHeader,
      width: "minmax(0,1fr)",
      value: (r) => r.index,
      cell: (r) =>
        r.bucket.partial ? `${r.bucket.label} (so far)` : r.bucket.label,
    },
    ...series.map((s) =>
      num(s.label, `s:${s.key}`, (r) => s.values[r.index] ?? null),
    ),
    ...(total
      ? [num("Total", "__total", (r) => stackTotal(series, r.index))]
      : []),
    ...(compare
      ? [
          num(
            compare.label,
            "__compare",
            (r) => compare.values[r.index] ?? null,
          ),
        ]
      : []),
  ];
  return (
    <Scroll style={{ maxHeight }}>
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(r) => String(r.index)}
        rowActivation={onPick ? (r) => () => onPick(r.index) : undefined}
      />
    </Scroll>
  );
}
