import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useMetric,
  useMetricCatalog,
  useMetricDetails,
  useMetricDetailsTotal,
} from "./internal/use-metric";
export { defineBoardConfig } from "./internal/board-config";
export type { BoardConfig } from "./internal/board-config";
export type { BoardContext } from "./internal/query";
export { Delta } from "./components/delta";
export type { DeltaProps } from "./components/delta";
export { MetricTile } from "./components/metric-tile";
export type { MetricTileProps } from "./components/metric-tile";
export { MetricCard } from "./components/metric-card";
export type {
  MetricBucket,
  MetricCardProps,
  MetricPick,
} from "./components/metric-card";
export { BreakdownCard } from "./components/breakdown-card";
export type { BreakdownCardProps } from "./components/breakdown-card";
export { MetricError } from "./components/metric-error";
export type { MetricErrorProps } from "./components/metric-error";
export { RangeBar } from "./components/range-bar";
export type { RangeBarProps } from "./components/range-bar";
export { DrillDrawer } from "./components/drill-drawer";
export type {
  DrillDrawerProps,
  DrillSource,
  DrillTarget,
} from "./components/drill-drawer";
export { BoardView } from "./components/board-view";
export type { BoardViewProps } from "./components/board-view";
export { Board } from "./components/board";
export type { BoardProps } from "./components/board";

export default {
  description:
    "Metrics surfaces: useMetricCatalog / useMetric / useMetricDetails / useMetricDetailsTotal (live reads of the served metrics values — the details one key-range pages, every loaded one live, and its total the per-question meta sibling — so a change the metric's source announces refetches what is on screen, without polling), MetricTile (KPI toggle with value, polarity-coloured delta and sparkline), MetricCard (controls derived from the catalog entry: split, daily | cumulative for flows, table twin, previous-period line on the unsplit total), BreakdownCard, RangeBar, the DrillDrawer listing the records behind a bucket, BoardView (sections of focus tiles, a lead card and a card grid, every ref checked against the catalog) and Board (a view-core tabbed board whose specs live in a config declared with defineBoardConfig).",
  contributions: [],
} satisfies PluginDefinition;
