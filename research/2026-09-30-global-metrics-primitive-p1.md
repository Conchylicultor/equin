# Metrics primitive — P1 implementation plan

Status: plan · 2026-09-30 · parent plan `research/2026-09-30-global-metrics-primitive.md`
(page `block-131804df-…`) · prototype `proto-1790501215-euqp`

> **Superseded (2026-10-09) — freshness and the read path.** `metricRevision`, the three
> endpoints and the revision-keyed queries are gone. The reads are live values
> (`metrics.catalog`, the typed-query `metrics.query`, the cursor-paged `metrics.details`),
> and freshness is a source's `changes` → one refcounted watch per source → each held
> tuple's `notify`. See `research/2026-10-09-global-live-structured-paged-values.md` and
> `plugins/primitives/plugins/metrics/CLAUDE.md`.

## Context

Every chart in `plugins/stats` hand-rolls its endpoint shape, its bucketing (`keyFor` in
`stats/commits/server/internal/handle-rate.ts:27`, UTC only) and its recharts styling. None of it
can be reused by a Pages `/chart` block, a DataView dashboard tab or Debug. P1 builds the
primitive that the later phases sit on: declare a metric once as data, evaluate it on the server
through one engine, and render it as a tile, card, table or board. P1 ships **no real
providers**. Every test uses a fake source. P2 moves tasks, cost and commits onto the primitive.

Scope: `plugins/primitives/plugins/metrics/` (core, shared, server, web) and its child
`plugins/metrics/plugins/chart-kit/` (core, web).

## Where P1 refines the parent plan

1. **The SQL helpers join against the engine's own intervals instead of calling `date_trunc`.**
   `sqlFlow` and `sqlLevel` receive the interval list that `core/intervals` already built and
   join against it: `unnest($starts, $ends) WITH ORDINALITY`. This leaves one bucketing
   implementation, in JS and tz-aware. SQL never re-derives a day boundary, so the two cannot
   drift. The same query also evaluates the range and previous-range intervals, which covers
   distinct counts and medians correctly.
2. **`EntityLink` becomes `{ href }`, built by the provider with `route.link(app, params)`.**
   Nothing in the app resolves a RouteDef by its id string, since the pane registry is keyed by
   pane. A link the provider builds satisfies `no-hand-built-link-to`, and the drawer only calls
   `navigate(href)`.
3. **`compare` and `split` exclude each other in the type.** `MetricQuery` is a union: either
   `{ split }` or `{ compare: boolean }`. "Previous period only when unsplit" is then a rule that
   cannot be written wrong, where the parent plan enforced it at runtime.
4. **Deferred:** `MetricPicker` moves to P6, its only consumer. The `metrics:board-refs` check
   moves to P2, the first phase with committed boards.
5. **Added:** chart-kit contributes `Specimens.Specimen` entries with fixed data. This lets the
   charts be screenshotted in the real app, in light and dark, before any provider exists.

## Layout

```
plugins/primitives/plugins/metrics/
  package.json  CLAUDE.md
  core/
    index.ts
    define-metric.ts   defineMetricSource / defineMetric / defineBreakdown → frozen data, global id "<source>.<metric>"
    params.ts          ParamSpec = bool(def) | enumOf(values, def) | stringList(def); parseParams(specs, raw) → typed | error
    intervals.ts       resolveRange(query, now, tz) → { buckets, previous?, range, previousRange?, unit }
    engine.ts          evaluateMetric(decl, query, evaluate, now) (pure); cumulative(); tileValue(); delta()
    wire.ts            zod: MetricQuery, MetricResult, Catalog, DrillItem, DrillPage, EntityLink, Bucket
    board.ts           zod BoardSpec (sections → focus items + cards, MetricRef/CardRef), tab params
    intervals.test.ts  engine.test.ts  params.test.ts
  shared/
    endpoints.ts       getMetricCatalog (GET), queryMetric (POST), metricDetails (POST)
  server/
    index.ts           contributions: served metricRevision; httpRoutes: catalog/query/details
    internal/contribution.ts   MetricsServer.Source = defineServerContribution<SourceImpl>("metrics.source")
    internal/registry.ts       collect + index; duplicate source/metric ids throw at first read (collect time)
    internal/handle-*.ts       catalog / query / details: 400 via HttpError for unknown ids, splits, params
    internal/sql.ts            sqlFlow / sqlLevel
    internal/revision.ts       metricRevision served external; rev = `${bootId}:${n}`; bump via source.changes
    internal/sql.test.ts       createTestDb-backed
  web/
    index.ts
    use-metric-catalog.ts  useMetric.ts (useQuery over fetchEndpoint; key includes the rev from useLive(metricRevision))
    components/metric-tile.tsx  metric-card.tsx  range-bar.tsx  drill-drawer.tsx  metric-error.tsx
    components/board.tsx         BoardView (one BoardSpec) + Board (view-core tabs)
    board-config.ts              defineBoardConfig(id, pluginId) → { webContributions, descriptors } (+ server twin)
    __tests__/tile.test.tsx  card.test.tsx  board.test.tsx
  plugins/chart-kit/
    core/  scale.ts (niceTicks, niceStep, linear scale), bar-path.ts (end-rounded barPath), layout.ts (stack/mirror/net domains), format.ts (axis formatters by unit) + *.test.ts
    web/   TimeChart, Sparkline, Histogram, ChartTable, ChartOrTable, ChartState, Legend, Tooltip; specimens.tsx
           __tests__/time-chart.test.tsx  histogram.test.tsx
```

## Core

**Declarations** (data only, `as const` splits and params):

```ts
type Measure = "flow" | "level" | "rate";
type Unit = "count" | "usd" | "seconds" | "percent" | "lines";
defineMetricSource({ id, label, params: { singularityOnly: bool(true) } })
defineMetric(src, { id, label, description?, unit, polarity: "up"|"down"|"neutral", measure,
  splits: [{ id, label }] as const, params: ["singularityOnly"] as const, drill?: { label } })
defineBreakdown(src, { id, label, unit, order: "value-desc"|"value-asc"|"label" })
```

A metric's `params` must be keys of its source's params. `tsc` checks this through the generic
over `src`.

**`intervals.ts`**: the one bucketing implementation. It builds on `packages/wall-clock`
(`startOfLocalDay`, `wallClockToInstant`, `zoneWallClock`).

- `Interval = { start: ISO; end: ISO }` is half-open.
- `Bucket = Interval & { partial: boolean; short: string; label: string }`.
- Presets:
  - 7D, 30D and 90D use day buckets that end with today, which is partial and whose end is
    clipped to now.
  - 1Y uses 53 Monday-aligned weeks.
- A custom `Interval` takes `bucket: day | week | month`.
- The previous period is shifted in calendar units: N days, or 53 weeks for 1Y so weekdays line
  up. Its last bucket is clipped at `now − (now − lastBucket.start)`, so a partial bucket is
  compared like for like.
- Labels: `short` reads "Sep 3". `label` reads "Sat, Sep 3", or "Sep 3 – Sep 9" for a week.
  Both come from `Intl`.

**`engine.ts`**: `evaluateMetric` is pure; `evaluate` is injected.

- **One evaluate call.** The engine builds `[...buckets, ...prevBuckets, range, prevRange]` and
  calls the provider's `evaluate` once. It checks the result: one row per split key, and each row
  as long as the interval list. A mismatch throws.
- **Split queries.** The engine makes a second, unsplit evaluate over `[range]`, so a split card
  still has a correct total for rate metrics. It never sums buckets.
- **Tile value.**
  - flow: the range total.
  - level: the value of the last bucket, and the previous period's last bucket for comparison.
  - rate: the range evaluated as one interval.
- **`null` means not covered.** A null value flows through as null and is drawn as a gap. Sums
  over any null bucket are null.
- **`delta(cur, prev)`** returns one of:
  - `{ kind: "pct", value }`
  - `{ kind: "new" }` when prev is 0
  - `{ kind: "none" }` when either side is null
- **`cumulative(values)`** is legal for flow only. Illegal display combinations (cumulative on a
  level, stack on a rate) come back from `displayError(decl, display)` as a typed error, and the
  card renders it as an error card.

**`wire.ts`**

```ts
MetricQuery = { metric; range: { preset } | { interval, bucket }; tz; params }
  & ({ split: string } | { compare: boolean })
MetricResult = { kind: "series", buckets, series[{ key, label, values, total }], total, previous? }
             | { kind: "breakdown", rows[{ key, label, value, link? }] }
DrillItem = { id, title, subtitle?, value?, at, link?: { href } }
DrillPage = { items, total, nextCursor }
Catalog = { sources[{ id, label, params: ParamSpec[] }], metrics[{ id, source, label, description?, unit, polarity, measure, splits, params, drill? }], breakdowns[…] }
```

## Server

- **`MetricsServer.Source({ source, metrics: [{ metric, evaluate, details? }], breakdowns: [{ breakdown, evaluate }], changes? })`.**
  `changes(bump) → unsubscribe` is how a source declares what makes its numbers stale. It is
  wired into `serveValue(metricRevision, { source: "external", whileSubscribed })`, keyed by
  `sourceId`.
- **Handlers** (`implement`, registered in `httpRoutes`):
  - The catalog is built once from `.getContributions()`.
  - `query` parses the body, parses params against the specs, resolves the range in the query's
    tz, then runs `evaluateMetric`.
  - `details` calls the metric's `details` with `{ interval, splitKey, params, cursor, limit }`.
  - Unknown ids, unknown splits, bad params and a missing `details` each return `HttpError(400)`.
- **`sqlFlow({ from, time, where?, split?: { expr, label? }, agg })`** returns
  `(ctx) => Promise<Row[]>`. It joins the interval list as
  `t.time >= s AND t.time < e`, groups by interval index and split key, and fills missing cells
  with 0. The provider marks a cell `null` only where its data is not covered.
- **`sqlLevel({ from, start, end, where?, split? })`** counts rows open at each interval end:
  `start < e AND (end IS NULL OR end >= e)`.
- Both helpers are drizzle `sql` fragments. Rows are read through `database/sql-rows`
  `queryRows`, which zod-parses them.

## Web

- **`useMetricCatalog()`** is `useEndpoint(getMetricCatalog)`.
- **`useMetric(query)`** is `useQuery` over `fetchEndpoint(queryMetric)`. Its key includes the
  source's `rev` from `useLive(metricRevision, { sourceId })`. It returns
  `loading | ok | error` and never an empty stand-in.
- **`MetricTile`** shows the label, a value formatted by unit and auto-compacted, the delta
  coloured by polarity × direction, and a Sparkline. It is a button with `aria-pressed`, selected
  when `selected`, as in the prototype.
- **`MetricCard`** reads its controls from the catalog entry:
  - *Split by*: Total plus the metric's splits.
  - *Daily | Cumulative*: offered for flow metrics only.
  - A table toggle.

  It draws the previous period only when the metric is unsplit, which the `MetricQuery` union
  guarantees.
- **`RangeBar`** holds the presets as a `SegmentedControl` and a "Compare to previous" toggle.
- **`DrillDrawer`** is a `Sheet side="right"` about 440px wide. It shows the bucket label, then
  one group per metric in the view that declares `details` (deduped by source). Each group lists
  up to 5 items, with "Show all" following `nextCursor`. A row calls `navigate(link.href)`.
- **`BoardView({ spec, params, onPick })`**:
  - Renders sections. A section can have a focus row, where the tiles choose the lead card, plus
    a grid of cards.
  - Shows `OutlineRail` when there are two or more sections.
  - Refs are validated against the catalog. An unknown ref renders an error card.
  - Range, compare, the selected tile and the table toggle are stored with
    `useDraft(\`${storageKey}:${viewId}\`)`.
- **`Board({ configId, storageKey, onPick? })`** wires `useViewModel` with a single `"board"`
  view type (`ViewTypeMeta`) and `EditableViewSwitcher`, then renders `BoardView` for the active
  instance.
  - When `onPick` is not given, it opens `DrillDrawer`.
  - The board's `BoardSpec` is zod-parsed from `viewFor(id)`. A parse failure renders an error
    card.
  - `defineBoardConfig` wraps `buildViewDescriptors`, `buildViewConfigContributions` and
    `buildViewConfigRegistrations`. P2's dashboard plugin calls it with its own config id.
    metrics is the first view-core consumer outside data-view.

## chart-kit

Chart-kit is a port of the prototype's SVG kit. It knows nothing about metrics. Its inputs are
`buckets { short, label, partial }`, `series { key, label, color?, values }` and
`compare? { label, values }`.

- **TimeChart** takes `kind: area | line | stack | mirror | net`.
  - Margins are `{ l: 46, r: 10, t: 8, b: 24 }`.
  - Bar width is `max(1, min(24, band × .7, band − 2))`.
  - Bars have 4px rounded ends and are square at the baseline (`barPath`).
  - Stacked segments have a 2px surface gap, and only the top segment is rounded.
  - Mirror and net bars sit 1px off the zero line.
  - Lines are 2px with round joins, and area fills are the series colour at 10% opacity.
  - Gridlines are 1px and solid. The zero line uses the axis token.
  - X labels are thinned to about 78px each.
- **Additions over the prototype:**
  - A partial bucket is drawn as a hatched or lighter bar, or a dashed last line segment.
  - `n = 0` and `n = 1` are guarded.
  - Arrow keys step the focused bucket for keyboard access.
  - The svg has `role="img"`.
- **Compare overlay:** a dashed 1.5px neutral line, `4 4`.
- **Hover:** one transparent hit rect.
  - Bar kinds get a hover band, and the other bars dim to .55.
  - Line kinds get a crosshair and markers with r = 4 and a 2px surface ring.
  - The HTML tooltip flips at the right edge and shows date, total (stacked), rows and the
    compare row.
  - Click calls `onPick(i)`.
- **Other components:**
  - **Sparkline** is 84×28 with an end dot.
  - **Histogram** has bars up to 40px.
  - **ChartTable** lists newest first; clicking a row calls `onPick`.
  - **ChartState** renders loading, error or empty at the chart's height, so the layout does not
    jump.
  - **Legend** appears only when there are two or more series or a compare line.
- **Colours** are CSS vars from ui/tokens:
  - Series use `--categorical-1…10` in fixed order and never cycle. A tenth series and beyond
    fold into "Other".
  - Sequential colours use `--chart-*`.
  - Compare, grid and axis use neutral tokens, and net uses positive and negative tokens.
  - Text never wears a series colour.
- **Validation:** `validate_palette.js` runs on the resolved categorical-1…8 values, light and
  dark, as a step in the implementation. Any FAIL is reported to the user and not patched
  silently.
- **Width:** `useElementSize` from `primitives/dom/element-size`, never a hand-rolled
  ResizeObserver.
- **Specimens:** `chart-kit.time-chart` (every kind, with compare and partial),
  `chart-kit.histogram` and `chart-kit.sparkline`, with fixed fixture data.

## Tests (acceptance)

- **bun: `intervals.test.ts`**
  - Monday-aligned weeks.
  - 1Y = 53 weeks, with a previous period 53 weeks back on the same weekdays.
  - A partial last bucket is flagged and clipped.
  - The previous period's last bucket is clipped like for like.
  - In `Europe/Paris` across the October DST change, a day bucket is 25h and boundaries fall at
    local midnight.
  - A custom interval with month buckets.
- **bun: `engine.test.ts`**, with a fake source:
  - A flow total equals the range interval, not a sum of buckets.
  - A level tile is the value at range end.
  - A rate tile is evaluated over one interval (a median case where the sum of buckets differs).
  - Null coverage gives gaps and a null total.
  - `previous` is present only when unsplit.
  - A split query's total comes from the unsplit evaluation.
  - A result of the wrong length throws.
  - `delta` gives new, none and pct.
  - Illegal display combinations give a typed error.
- **bun:** `params.test.ts`, and chart-kit's `scale`, `bar-path` and `layout` tests.
- **bun + DB: `sql.test.ts`** (`createTestDb`)
  - `sqlFlow` count and split over a seeded table.
  - `sqlLevel` open-at-end.
  - A distinct count over the range interval.
- **jsdom tests.** These mock `useElementSize` to a fixed width.
  - **TimeChart:**
    - The bar count equals the non-zero buckets.
    - Hover shows the tooltip with the right values.
    - Compare renders a dashed path.
    - The table fallback renders the rows.
    - A partial bucket gets the partial style.
  - **Histogram:** one bar per bin.
- **jsdom: board**, with `fetchEndpoint` stubbed and the fake catalog and results:
  - Tiles and cards show `Loading` while pending.
  - An unknown ref renders an error card.
  - Selecting a tile switches the lead card.
  - Clicking a bucket opens the drawer with the details.

## Verification

1. `./equin test plugins/primitives/plugins/metrics` runs bun and jsdom, all green.
2. `./equin build` runs in the background and ends with `build-status.json` `status: ok`.
   Its `check` covers boundaries, barrel purity, the plugins-doc and registry sync, and the
   lints.
3. `GET /api/metrics/catalog` returns an empty catalog, since there are no providers. A query
   for an unknown metric gets a 400.
4. Screenshot the chart-kit specimens, light and dark, with `e2e-harness/e2e/screenshot.ts`
   `--path` to the specimen route and `--color-scheme dark|light`. Check them by eye against
   `compare-diff`-style framing of the prototype and against the dataviz anti-patterns list.

## Critical files reused

- `plugins/framework/plugins/server-core/core/contributions.ts`: `defineServerContribution`.
  Pattern: `plugins/backup/server/internal/contribution.ts`.
- `plugins/infra/plugins/endpoints/{core,server,web}`: `defineEndpoint`, `implement`,
  `HttpError`, `fetchEndpoint` and `useEndpoint`. The POST-with-`useQuery` pattern is in
  `apps/deploy/analytics/dashboard/web/internal/use-deployment-analytics.ts`.
- `plugins/network/plugins/live`: `liveValue`, `serveValue` (external, with `whileSubscribed`)
  and `useLive`. Pattern: `debug/queue-health/server/internal/pulse.ts`.
- `plugins/packages/plugins/wall-clock/core`.
- `plugins/primitives/plugins/data-view/plugins/view-core/{web,server}`. Wiring reference:
  `data-view/web/internal/{descriptors,config-registrations,use-data-view-model}.ts`.
- UI pieces:
  - `outline/rail/web` `OutlineRail`
  - `persistent-draft/web` `useDraft`
  - `loading/web` `Loading`
  - `live-state/web` `ResourceErrorInline`
  - `css/ui-kit/web` `Sheet`
  - `css/toggle-chip/web` `SegmentedControl`
  - `css/card/web` `Card`
  - `dom/element-size/web` `useElementSize`
- `apps-core/tabs/web` `navigate`, and `plugin-meta/specimens/web` `Specimens.Specimen`.
- `database/db-test-fixture` `createTestDb` and `database/sql-rows` `queryRows`.
- Tokens: `ui/tokens/plugins/categorical`, `ui/tokens/plugins/chart`.

## Out of scope (later phases)

Real providers and the Dashboard plugin (P2), the `metrics:board-refs` check (P2), push-metrics
and the Debug sections (P3), migrating health-monitor and deploy onto chart-kit plus the recharts
lint (P4), the DataView dashboard view (P5), and `MetricPicker` with the `/chart` block (P6).
