import type { ReactNode } from "react";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { TimeChartKind } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/core";
import {
  ChartOrTable,
  ChartState,
} from "@plugins/primitives/plugins/metrics/plugins/chart-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  cumulative as runningSum,
  displayError,
  type CatalogMetric,
  type DisplayChart,
  type MetricRef,
  type SeriesResult,
  METRIC_MAX_SERIES,
} from "../../core";
import type { CardViewState } from "../internal/board-state";
import { boardQuery, type BoardContext } from "../internal/query";
import { useMetric } from "../internal/use-metric";
import { CardFrame } from "./card-frame";
import { CARD_CHART_HEIGHT, matchChart } from "./chart-resource";
import { MetricError } from "./metric-error";

const tableIcon = symbol("table");
const chartIcon = symbol("monitoring");

/** One bucket of a series result — what a drill-down is anchored on. */
export type MetricBucket = SeriesResult["buckets"][number];

/** A click on one bucket of a metric's chart. */
export interface MetricPick {
  metric: CatalogMetric;
  bucket: MetricBucket;
  /** The raw params the card queried with (the board's, for this metric). */
  params: Record<string, unknown>;
}

export interface MetricCardProps {
  entry: CatalogMetric;
  /** The authored ref: its split is the card's default, its chart the drawing. */
  metricRef: MetricRef;
  context: BoardContext & { compare: boolean };
  view: CardViewState;
  onView: (patch: CardViewState) => void;
  onPick?: (pick: MetricPick) => void;
}

/** The empty-string id stands for the unsplit total (no split id is empty). */
const TOTAL = "";

/**
 * The chart a metric is drawn as when the ref names none: a flow in columns,
 * a level as a filled line (stacked when split), a rate as a line — a rate's
 * series cannot be added up, so it is never stacked.
 */
function defaultChart(
  entry: CatalogMetric,
  split: boolean,
  cumulative: boolean,
): DisplayChart {
  if (entry.measure === "rate") return "line";
  if (cumulative) return split ? "line" : "area";
  if (entry.measure === "level") return split ? "stack" : "area";
  return "stack";
}

/**
 * One metric as a chart card. Its controls come from the catalog entry: Split
 * by (Total plus the metric's splits), Daily | Cumulative for a flow only, and
 * the table twin. The previous period is drawn only on the unsplit total —
 * the query itself has no spelling for a split compared with the past.
 */
export function MetricCard({
  entry,
  metricRef,
  context,
  view,
  onView,
  onPick,
}: MetricCardProps): ReactNode {
  const split =
    view.split === undefined ? (metricRef.split ?? null) : view.split;
  const isCumulative = entry.measure === "flow" && (view.cumulative ?? false);
  const asTable = view.table ?? false;
  const chart =
    metricRef.chart ?? defaultChart(entry, split !== null, isCumulative);
  const query = boardQuery(entry, context, split);
  const result = useMetric(query);

  const illegal = displayError(entry, { chart, cumulative: isCumulative });
  if (illegal !== null) {
    return <MetricError title={entry.label} message={illegal.message} />;
  }

  const controls = (
    <>
      {entry.splits.length > 0 && (
        <SegmentedControl
          options={[
            { id: TOTAL, label: "Total" },
            ...entry.splits.map((s) => ({ id: s.id, label: `By ${s.label}` })),
          ]}
          value={split ?? TOTAL}
          onChange={(id) => onView({ split: id === TOTAL ? null : id })}
        />
      )}
      {entry.measure === "flow" && (
        <SegmentedControl
          options={[
            { id: "per", label: context.preset === "1y" ? "Weekly" : "Daily" },
            { id: "cumulative", label: "Cumulative" },
          ]}
          value={isCumulative ? "cumulative" : "per"}
          onChange={(id) => onView({ cumulative: id === "cumulative" })}
        />
      )}
      <IconButton
        icon={asTable ? chartIcon : tableIcon}
        label={asTable ? "Show chart" : "Show as table"}
        active={asTable}
        aria-pressed={asTable}
        onClick={() => onView({ table: !asTable })}
      />
    </>
  );

  return (
    <CardFrame
      title={entry.label}
      description={entry.description}
      controls={controls}
      data-metric-card={entry.id}
    >
      {matchChart(result, entry.label.toLowerCase(), (data) =>
        data.kind === "series" ? (
          <SeriesBody
            entry={entry}
            data={data}
            kind={chart}
            cumulative={isCumulative}
            showCompare={split === null && context.compare}
            asTable={asTable}
            onPick={
              onPick === undefined
                ? undefined
                : (bucket) =>
                    onPick({ metric: entry, bucket, params: query.params })
            }
          />
        ) : (
          <ChartState
            state="error"
            height={CARD_CHART_HEIGHT}
            message={`"${entry.id}" answered a breakdown, not a series`}
          />
        ),
      )}
    </CardFrame>
  );
}

function SeriesBody({
  entry,
  data,
  kind,
  cumulative,
  showCompare,
  asTable,
  onPick,
}: {
  entry: CatalogMetric;
  data: SeriesResult;
  kind: TimeChartKind;
  cumulative: boolean;
  showCompare: boolean;
  asTable: boolean;
  onPick?: (bucket: MetricBucket) => void;
}): ReactNode {
  if (data.series.length === 0) {
    return <ChartState state="empty" height={CARD_CHART_HEIGHT} />;
  }
  const shape = (values: readonly (number | null)[]) =>
    cumulative ? runningSum(values) : values;
  const previous = data.previous;
  const chart = (
    <ChartOrTable
      asTable={asTable}
      label={entry.label}
      kind={kind}
      unit={entry.unit}
      height={CARD_CHART_HEIGHT}
      buckets={data.buckets}
      series={data.series.map((s) => ({
        key: s.key,
        label: s.label,
        values: shape(s.values),
      }))}
      compare={
        showCompare && previous !== undefined
          ? { label: previous.label, values: shape(previous.values) }
          : null
      }
      onPick={
        onPick === undefined ? undefined : (i) => onPick(data.buckets[i]!)
      }
      pickHint={onPick === undefined ? undefined : "Click to see what happened"}
    />
  );
  if (!data.truncated) return chart;
  return (
    <Stack gap="none">
      {chart}
      <Text variant="caption" tone="muted">
        Showing the top {METRIC_MAX_SERIES} by total
      </Text>
    </Stack>
  );
}
