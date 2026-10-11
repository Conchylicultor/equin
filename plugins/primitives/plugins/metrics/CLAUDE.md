# metrics

Declare a metric once, as data, and draw it anywhere — a KPI tile, a chart, a
table, a board tab. Providers live in their domain's home and contribute a
`MetricsServer.Source`; every surface reads the served catalog and sends
queries, so no consumer ever imports a provider.

Plans: [`research/2026-09-30-global-metrics-primitive.md`](../../../../research/2026-09-30-global-metrics-primitive.md)
(the whole primitive and its phases) and
[`research/2026-09-30-global-metrics-primitive-p1.md`](../../../../research/2026-09-30-global-metrics-primitive-p1.md)
(this phase).

## Declaring (core, data only)

```ts
export const costSource = defineMetricSource({
  id: "cost", label: "Spend", params: { singularityOnly: bool(true) },
});
export const spend = defineMetric(costSource, {
  id: "spend", label: "Spend", unit: "usd", polarity: "down", measure: "flow",
  splits: [{ id: "model", label: "Model" }], params: ["singularityOnly"],
  drill: { label: "Conversations" },
});                                   // global id "cost.spend"
export const top = defineBreakdown(costSource, {
  id: "top-conversations", label: "Most expensive", unit: "usd", order: "value-desc",
});
```

`measure` decides every legal aggregation:

| measure | over time | across splits | tile | cumulative | stack / net |
|---|---|---|---|---|---|
| `flow` | sums | sums | the range evaluated as one interval | yes | yes |
| `level` | value at bucket end | sums | the last bucket (value at range end) | no | yes |
| `rate` | neither | neither | the range evaluated as one interval | no | no |

A metric's `params` must be keys of its source's `params` (tsc, and a throw at
define time for an untyped caller). `displayError(decl, display)` returns the
typed reason a display is illegal.

## Serving (server)

```ts
MetricsServer.Source({
  source: costSource,
  metrics: [serveMetric(spend, { evaluate, details, detailsTotal })],
  breakdowns: [serveBreakdown(top, { evaluate })],
  changes: (bump) => onCostRefreshed(bump),   // → unsubscribe
});
```

- `evaluate({ intervals, split, params })` returns one row per split key (exactly
  one row when `split` is null), each with one value per interval. `null` means
  *not covered* and is drawn as a gap — never write 0 for "no data yet".
- `serveMetric` / `serveBreakdown` type the evaluator against the declaration's
  own params.
- **Drill-down:** `details({ interval, split, params, range })` answers ONE key
  range of the bucket's records — newest first, by `at` then `id`: the records
  strictly after `range.after`, up to and including `range.until`, at most
  `range.limit` (network/live's `sliceRange` answers it for a list held in
  memory; `checkPagedSource` from `network/live/server/testing` holds a
  provider to it). A cut is a position, not a record: it stays valid after its
  record is gone. `at` is UTC at exactly millisecond precision
  (`Date#toISOString`), so its text order is time order. The optional
  `detailsTotal({ interval, split, params })` counts them; without it the
  total is `null` (not counted), never 0. The registry throws at first read on a duplicate source or id, a
  metric contributed under another source, or `drill` without `details` (or
  the reverse).
- **SQL-backed metrics:** `sqlFlow({ db, from, time, agg, where?, splits?, empty? })`
  and `sqlLevel({ db, from, start, end, where?, splits? })`. Both join the table
  against the engine's own intervals (`unnest($starts, $ends) WITH ORDINALITY`),
  so no day boundary is ever re-derived in SQL (no `date_trunc`). `empty` is the
  value of an interval no row falls in: 0 for a count or sum, `null` for a
  median or ratio.
- **Freshness:** a source's `changes` → one refcounted watch per source
  (`server/internal/source-watch.ts`) → each held tuple's `notify`. Every
  served query and drill-down watches its metric's source while a tab holds
  it (`whileSubscribed` — once per drill-down QUESTION, however many of its
  pages and its total are held); the first starts `changes`, a change
  refetches all of them (throttled, 1 s), and the last release stops it. Nothing watches
  between spans, and nothing needs to — the runtime opens every subscription
  span with a fresh version. No revision tick, no polling.

## The engine (core)

`core/intervals.ts` is THE one bucketing implementation, tz-aware, on
`packages/wall-clock`: presets `7d`/`30d`/`90d` (day buckets ending with a
partial today) and `1y` (53 Monday-aligned weeks); a custom interval with
`day | week | month` buckets. The previous period is shifted back by the
range's own length in calendar units (53 weeks for `1y`, so weekdays line up),
and a clipped bucket is compared with the same elapsed part of its previous
unit.

`evaluateMetric` makes ONE provider call over
`[...buckets, ...previous, range, previousRange]`; a split query makes a second,
unsplit call over `[range]` for its total. A total is never a sum of buckets —
that is wrong for distinct counts, medians and ratios.

`MetricQuery` is `{ split }` XOR `{ compare }`: a previous-period line only
reads against one total, so the pair has no spelling.

## Reads — live values (`core/live.ts`)

- `metrics.catalog` — sources (with param specs), metrics, breakdowns; fixed
  per process (never notified — a restart re-subscribes).
- `metrics.query` — a typed-query value: a `MetricQuery` → `MetricResult`
  (`series` for a metric, `breakdown` for a breakdown). On-demand: each tab
  refetches after a change.
- `metrics.details` — a key-range-paged value over a `DetailsSelector`
  (metric, interval, split, params): the records behind one bucket (optionally
  one split key), cut at each record's `[at]` (desc, then id), pages of 50 up
  to 500 records. Each page is a keyed window: a source change re-reads the
  live pages and ships each one's keyed delta (pushed — a paged value has no
  `load`). Its per-question sibling `metricDetails.meta`
  (`metrics.details:meta`) is the bucket's total (`{ total: number | null }`),
  refreshed by the same source watch.

`web/internal/use-metric.ts`: `useMetricCatalog()`, `useMetric(query)`,
`useMetricDetails(selector)` (a `DETAILS_STEP` = 5-record preview, growing by
5 per "Show more", every loaded page live, capped at 500 — the drawer reads
"First N of total" there) and `useMetricDetailsTotal(selector)` (pending until
known, never 0) are `useLive` reads — the query names its metric, and the
server resolves the source. Unknown ids, splits and params, a bad range, and details on a metric
without them are a `MetricQueryError` — a `ResourceRefusal` — naming the
problem: the card's error arm shows that message (`refused`), and nothing is
reported as a server failure.

## Boards

`BoardSpec` (core) is a view-core instance's `options`: tab `params` keyed
`<source>.<param>` (`boardParamsFor` picks one metric's), and sections of
focus tiles + cards referencing metrics by global id. Range, compare, the
selected tile and the table toggle are device-local, never part of the spec.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Metrics surfaces: useMetricCatalog / useMetric / useMetricDetails / useMetricDetailsTotal (live reads of the served metrics values — the details one key-range pages, every loaded one live, and its total the per-question meta sibling — so a change the metric's source announces refetches what is on screen, without polling), MetricTile (KPI toggle with value, polarity-coloured delta and sparkline), MetricCard (controls derived from the catalog entry: split, daily | cumulative for flows, table twin, previous-period line on the unsplit total), BreakdownCard, RangeBar, the DrillDrawer listing the records behind a bucket, BoardView (sections of focus tiles, a lead card and a card grid, every ref checked against the catalog) and Board (a view-core tabbed board whose specs live in a config declared with defineBoardConfig). Metrics engine: the MetricsServer.Source contribution (a source's metrics and breakdowns bound to their evaluators), the served metrics.catalog / metrics.query / metrics.details live values evaluating any of them through the one tz-aware bucketing engine — each query and drill-down (its key-range pages and its total) watching its source's `changes` through one refcounted subscription per source — and the sqlFlow / sqlLevel helpers joining a table against the engine's intervals.
- Server:
  - Contributes:
    - `resource.declare` "metrics.catalog"
    - `resource.declare` "metrics.details"
    - `resource.declare` "metrics.details:meta"
    - `resource.declare` "metrics.query"
  - Uses:
    - `network/live.serveValue`
    - `primitives/data-view/view-core.buildViewConfigRegistrations`
  - Exports (types):
    - `BreakdownImpl`
    - `DetailsCtx`
    - `DetailsScope`
    - `MetricDetails`
    - `MetricDetailsTotal`
    - `MetricImpl`
    - `SourceImpl`
    - `SqlFlowSpec`
    - `SqlLevelSpec`
    - `SqlSplit`
  - Exports (values):
    - `boardConfigRegistrations`
    - `MetricsServer`
    - `serveBreakdown`
    - `serveMetric`
    - `sqlFlow`
    - `sqlLevel`
  - Resources:
    - `metrics.catalog` (push)
    - `metrics.details` (keyed, window)
    - `metrics.details:meta` (push)
    - `metrics.query` (invalidate)
- Web:
  - Uses: 39 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×7
    - `primitives/data-view/view-core` ×4
    - `primitives/live-state` ×4
    - `primitives/metrics/chart-kit` ×3
    - `network/live` ×2
    - `primitives/css/spacing` ×2
    - `primitives/css/toggle-chip` ×2
    - `apps-core/tabs.navigate`
    - `primitives/css/card.Card`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/inline.Inline`
    - `primitives/css/row.Row`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/outline/rail.OutlineRail`
    - `primitives/persistent-draft.useDraft`
    - `ui/icons.Icon`
  - Exports (types):
    - `BoardConfig`
    - `BoardContext`
    - `BoardProps`
    - `BoardViewProps`
    - `BreakdownCardProps`
    - `DeltaProps`
    - `DrillDrawerProps`
    - `DrillSource`
    - `DrillTarget`
    - `MetricBucket`
    - `MetricCardProps`
    - `MetricErrorProps`
    - `MetricPick`
    - `MetricTileProps`
    - `RangeBarProps`
  - Exports (values):
    - `Board`
    - `BoardView`
    - `BreakdownCard`
    - `defineBoardConfig`
    - `Delta`
    - `DrillDrawer`
    - `MetricCard`
    - `MetricError`
    - `MetricTile`
    - `RangeBar`
    - `useMetric`
    - `useMetricCatalog`
    - `useMetricDetails`
    - `useMetricDetailsTotal`
- Core:
  - Uses:
    - `network/live.liveValue`
    - `packages/wall-clock.wallClockToInstant`
    - `packages/wall-clock.zoneWallClock`
  - Exports (types):
    - `BoardSection`
    - `BoardSpec`
    - `BreakdownCtx`
    - `BreakdownDecl`
    - `BreakdownEvaluate`
    - `BreakdownOrder`
    - `BreakdownRef`
    - `BreakdownResult`
    - `BreakdownRow`
    - `Bucket`
    - `BucketUnit`
    - `CardRef`
    - `Catalog`
    - `CatalogBreakdown`
    - `CatalogMetric`
    - `CatalogSource`
    - `DeclParams`
    - `Delta`
    - `DetailsSelector`
    - `DisplayChart`
    - `DisplayError`
    - `DrillItem`
    - `DrillMeta`
    - `EngineQuery`
    - `EntityLink`
    - `EvaluateCtx`
    - `EvaluatedRow`
    - `Interval`
    - `Measure`
    - `MetricDecl`
    - `MetricDisplay`
    - `MetricEvaluate`
    - `MetricQuery`
    - `MetricRef`
    - `MetricResult`
    - `MetricSourceDecl`
    - `ParamSpec`
    - `ParamSpecs`
    - `ParamSpecWire`
    - `ParamValue`
    - `ParamValues`
    - `ParseParamsResult`
    - `Polarity`
    - `Preset`
    - `RangeSpec`
    - `ResolvedRange`
    - `Series`
    - `SeriesResult`
    - `SplitDecl`
    - `Unit`
  - Exports (values):
    - `boardParamsFor`
    - `BoardSectionSchema`
    - `BoardSpecSchema`
    - `bool`
    - `BREAKDOWN_ORDERS`
    - `BreakdownRefSchema`
    - `BreakdownResultSchema`
    - `BreakdownRowSchema`
    - `BUCKET_UNITS`
    - `BucketSchema`
    - `CardRefSchema`
    - `CatalogBreakdownSchema`
    - `CatalogMetricSchema`
    - `CatalogSchema`
    - `CatalogSourceSchema`
    - `cumulative`
    - `defineBreakdown`
    - `defineMetric`
    - `defineMetricSource`
    - `delta`
    - `DetailsSelectorSchema`
    - `DISPLAY_CHARTS`
    - `displayError`
    - `DrillItemSchema`
    - `DrillMetaSchema`
    - `EntityLinkSchema`
    - `enumOf`
    - `evaluateBreakdown`
    - `evaluateMetric`
    - `IntervalSchema`
    - `InvalidRangeError`
    - `isTimeZone`
    - `MAX_BUCKETS`
    - `MEASURES`
    - `metricCatalog`
    - `metricDetails`
    - `metricQuery`
    - `MetricQuerySchema`
    - `MetricRefSchema`
    - `MetricResultSchema`
    - `paramSpecsToWire`
    - `ParamSpecWireSchema`
    - `parseParams`
    - `POLARITIES`
    - `PRESETS`
    - `RangeSpecSchema`
    - `resolveRange`
    - `SeriesResultSchema`
    - `SeriesSchema`
    - `stringList`
    - `tileValue`
    - `UNITS`
- Sub-plugins:
  - **`chart-kit`** — Hand-rolled SVG chart kit, knowing nothing about metrics: TimeChart (area / line / stack / mirror / net, a dashed compare line, gaps for null, partial buckets drawn lighter / dashed, hover +…

<!-- AUTOGENERATED:END -->
