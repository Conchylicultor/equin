import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  metricCatalogServed,
  metricDetailsServed,
  metricQueryServed,
} from "./internal/resources";

export {
  MetricsServer,
  serveBreakdown,
  serveMetric,
} from "./internal/contribution";
export type {
  BreakdownImpl,
  DetailsCtx,
  DetailsScope,
  MetricDetails,
  MetricDetailsTotal,
  MetricImpl,
  SourceImpl,
} from "./internal/contribution";
export { sqlFlow, sqlLevel } from "./internal/sql";
export { boardConfigRegistrations } from "./internal/board-config";
export type { SqlFlowSpec, SqlLevelSpec, SqlSplit } from "./internal/sql";

export default {
  description:
    "Metrics engine: the MetricsServer.Source contribution (a source's metrics and breakdowns bound to their evaluators), the served metrics.catalog / metrics.query / metrics.details live values evaluating any of them through the one tz-aware bucketing engine — each query and drill-down (its key-range pages and its total) watching its source's `changes` through one refcounted subscription per source — and the sqlFlow / sqlLevel helpers joining a table against the engine's intervals.",
  contributions: [
    ...metricCatalogServed.declare,
    ...metricQueryServed.declare,
    ...metricDetailsServed.declare,
  ],
} satisfies ServerPluginDefinition;
