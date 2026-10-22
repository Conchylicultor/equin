# Metrics primitive, and the agent-manager Dashboard

Status: plan · 2026-09-30 · prototype `proto-1790501215-euqp` · vision page `block-ddd8fe65-5220-40e0-b06c-7b4f228808c7` ("Charts")

## Context

The agent manager's **Stats** page (`plugins/stats`) is one monolithic scroll of
unrelated charts: 15 recharts components across five sub-plugins
(`tasks`, `cost`, `commits`, `pushes`, `responsiveness`), each with its own
endpoint shape, its own toggles and its own bucketing code (`keyFor` is
written twice). Nothing is reusable: the only shared piece,
`stats/commits/web/components/chart-primitives.tsx`, is imported by
`debug/health-monitor` and `deploy/analytics/dashboard`, which each re-style
recharts again.

We want:

1. **A generic way to declare a metric once** and render it anywhere: as a
   KPI tile, a chart, a table, a Pages `/chart` block, or a tab of a DataView.
2. **A Dashboard** in the agent manager, replacing Stats. It shows the three
   agent-fleet questions (tasks, spend, code) with the UX validated in the
   prototype: tabs, one global range, previous-period comparison, tiles that
   choose the lead chart, and click-a-bucket drill-down.
3. **The two system-performance cards go to Debug.** Pushes goes to
   Profiling, and responsiveness goes next to its data (`debug/latency-ledger`).

Decisions already taken with the user:

- The primitive lives at `plugins/primitives/plugins/metrics/`, a deliberate
  exception to "no new top-level primitives".
- **Providers live in domain homes**, not under the Dashboard, so any surface
  can use a metric without depending on the agent manager.
- **v1 buckets by UTC day** (today's behaviour). The query contract carries a
  `tz` from day one.
- Layers: metric → section → view. Tabs are view-core named instances, so a
  deleted tab can be re-added.
- A DataView `dashboard` view type (switch Table ↔ Dashboard, filters flow
  into the charts, bar click drills into the table) is a later phase built on
  the same spec.

## Design

### Plugin layout

```
plugins/primitives/plugins/metrics/
  core/    define-metric.ts   defineMetricSource / defineMetric / defineBreakdown (data only)
           params.ts          closed ParamSpec union (bool | enum | stringList)
           intervals.ts       range → buckets (+ previous period), partial flag, labels
           engine.ts          evaluateMetric: pure; totals, compare, cumulative, tile values
           wire.ts            zod: MetricQuery, MetricResult, Catalog, DrillItem, EntityLink
  shared/  endpoints.ts       catalog / query / details (plugin-private)
  server/  MetricsServer.Source contribution (defineServerContribution), handlers,
           sqlFlow / sqlLevel helpers, metricRevision keyed liveValue
  web/     useMetricCatalog, useMetric, MetricTile, MetricCard, Board, RangeBar,
           DrillDrawer, MetricPicker, board view type (view-core)
  plugins/chart-kit/web/     TimeChart (area | line | stack | mirror | net, compare overlay,
                             crosshair tooltip), Sparkline, Histogram, ChartTable, ChartState
```

`chart-kit` knows nothing about metrics. health-monitor and deploy analytics
use it directly. It is a port of the prototype's hand-rolled SVG, which meets
the dataviz specs recharts fights: ≤24px bars with 4px rounded ends, 2px
surface gaps, a 2px ring on markers, a dashed previous-period line, and a
crosshair that snaps to the nearest bucket. Series colours come from the
`ui/tokens` `categorical-*` group and sequential colours from `chart-*`.
Everything is re-validated with the dataviz validator in light and dark.

### Declaring a metric (core, data only)

```ts
type Measure = "flow" | "level" | "rate";
//   flow  — sums over time and across splits → stack ok, cumulative ok, tile = range total
//   level — value at bucket end, sums across splits only → stack ok, no cumulative, tile = value at range end
//   rate  — ratio / median / distinct, sums neither way → lines only, tile = the range evaluated as ONE interval
type Unit = "count" | "usd" | "seconds" | "percent" | "lines";

export const costSource = defineMetricSource({ id: "cost", label: "Spend",
  params: { singularityOnly: bool(true) } });
export const spend = defineMetric(costSource, { id: "spend", label: "Spend", unit: "usd",
  polarity: "down", measure: "flow", splits: [{ id: "model", label: "Model" },
  { id: "tokenKind", label: "Token kind" }] as const, params: ["singularityOnly"] as const,
  drill: { label: "Conversations" } });
export const topConversations = defineBreakdown(costSource, { id: "top-conversations",
  label: "Most expensive conversations", unit: "usd", order: "value-desc" });
```

The measure kind decides what can be written. `cumulative` on a `level`
metric, or `stack` on a `rate`, is rejected (a typed error card). Ratios stay
correct by construction: the engine asks the provider to evaluate the **whole
range as one interval** as well as each bucket. A total is therefore never
computed by adding up buckets, which is wrong for distinct counts, medians
and ratios.

### Evaluating (server)

```ts
MetricsServer.Source({
  source: costSource,
  metrics: [{ metric: spend,
    evaluate: ({ intervals, split, params }) => Promise<{ key; label; values: (number | null)[] }[]>,
    details?: ({ interval, splitKey, params, cursor, limit }) => Promise<Page<DrillItem>> }],
  breakdowns: [{ breakdown: topConversations, evaluate: (…) => Promise<BreakdownRow[]> }],
  changes: /* what bumps metricRevision({ sourceId }) */,
});
```

- The engine builds `[...buckets, ...previousBuckets, range, previousRange]`
  and makes **one** `evaluate` call. Every bucket is listed up front, so
  there are no missing days to fill in. `null` means "not covered" (e.g.
  before the cost archive starts) and is drawn as a gap, never as 0.
- `sqlFlow({ from, timeCol, where, split, agg })` and
  `sqlLevel({ startCol, endCol, split })` turn a DB-backed metric into a few
  lines. They use `date_trunc` in the query's tz and `generate_series` for
  levels. Tasks and pushes use them; cost (archive) and commits (git) evaluate
  in JS through `core/intervals`.
- **Endpoints.** `GET /api/metrics/catalog` returns every source, metric and
  breakdown with its label, unit, splits and ParamSpecs; it is fixed per boot.
  `POST /api/metrics/query` takes a `MetricQuery` and returns a
  `MetricResult`. `POST /api/metrics/details` returns `{ items, total,
  nextCursor }`. Unknown ids, splits or params get a 400. Query and details
  are POST with a body, so the web wraps `fetchEndpoint` in `useQuery`
  (`useEndpoint` is GET-only).
- **The catalog is served, never imported.** Registration happens once, on
  the server. The Pages picker and the Board list every metric without
  importing any provider, which keeps the metric collection separate from
  its consumers and leaves no web/server registry pair to drift.
- **Freshness without polling.** One keyed scalar `liveValue`,
  `metricRevision({ sourceId }) → { rev }`. Sources declare what bumps it:
  the tasks change feed, `git.refAdvanced`, the cost refresh job, op-store
  ingest. The rev is part of the query key, the same pattern as
  `changeTick` in `all-conversations`.

```ts
type MetricQuery = { metric: string; range: { preset: "7d" | "30d" | "90d" | "1y" } | Interval;
  tz: string; bucket?: "day" | "week" | "month"; split?: string; params: Record<string, unknown>;
  compare: boolean };
type MetricResult =
  | { kind: "series"; buckets: Bucket[]; series: { key; label; values: (number | null)[]; total: number | null }[];
      total: number | null; previous?: { values: (number | null)[]; total: number | null; label: string } } // unsplit only
  | { kind: "breakdown"; rows: { key; label; value: number; link?: EntityLink }[] };
type DrillItem = { id; title; subtitle?; value?: number; at: string; link?: EntityLink };
type EntityLink = { route: string /* core RouteDef id */; params: Record<string, string> };
```

### Rendering (web)

- **`useMetric(ref, board)`** returns a discriminated `loading | ok | error`,
  never an empty stand-in.
- **`MetricTile`** shows the `total` (for a level, the value at range end),
  the delta `(cur − prev) / |prev|` coloured by `polarity`, and a sparkline of
  the bucket values. When prev is 0 it shows "new"; when either side is null
  it shows "—".
- **`MetricCard`** derives its controls from the catalog entry: *Split by*
  from `splits`, *Daily | Cumulative* only for `flow`, and a table toggle. It
  draws the previous period only when the metric is unsplit.
- **`Board`** renders sections. A section can have a *focus* row, where tiles
  select the lead chart below them, plus a grid of cards. It also owns the
  `RangeBar` (range presets, compare), an outline rail when a view has more
  than one section, and `onPick(interval, splitKey)`.
- **Board layout is committed view-core config.** Each view instance is a tab:

  ```jsonc
  { "views": [ { "id": "spend", "name": "Spend", "view": { "type": "board",
      "params": { "cost.singularityOnly": true },
      "sections": [ { "id": "main",
        "focus": { "items": [ { "metric": "cost.spend", "split": "model" }, { "metric": "cost.per-conversation" }, … ] },
        "cards": [ { "metric": "cost.distribution" }, { "breakdown": "cost.top-conversations" } ] } ] } } ] }
  ```

  Tab-level `params` are written with `updateView(merge)`. Range, compare,
  the selected tile and the table toggle are *how you are looking*, not
  *what the board is*. They live device-locally via `useDraft` keyed
  `${storageKey}:${viewId}`.
- **Drill-down is the host's callback, not part of the metric contract.** The
  provider-backed Board opens `DrillDrawer`, with one group per metric in the
  view that declares `details` (deduped by source). The later DataView host
  instead sets a filter and switches to its table. `EntityLink` resolves
  through core RouteDefs; `conversationRoute` and `taskDetailRoute` already
  exist in core.

### Providers (domain homes)

| Source | New home | Metrics | Evaluates from |
|---|---|---|---|
| `tasks` | `tasks/plugins/task-metrics` | filed, completed, dropped (flow); open (level); time-to-done (rate, median) · split: category · details: tasks | `tasks_v` (`createdAt`, `finishedAt`, `droppedAt`, `heldAt`) via `sqlFlow`/`sqlLevel` |
| `cost` | `conversations/plugins/usage-cost` (moved from `stats/cost`, with its `data-dirs`, refresh job and archive) | spend (split model / token kind), conversations, per-conversation (rate), tokens; breakdowns: distribution, top conversations · param `singularityOnly` | year-sharded archive (UTC-day keyed) |
| `commits` | `code-explorer/plugins/commit-metrics` (moved from `stats/commits`) | commits (split category), lines added / removed, net lines, commit size (rate) · params `dedup`, `excludedPaths` · details: commits | `git log --numstat`, Singularity-Push dedup, `conversation_categories` |
| `pushes` | `debug/profiling/plugins/push-metrics` | throughput (split outcome), wait time (rate), step time (split step) | `op_log_ops` (op-store) via `sqlFlow` |

The moves go through `./singularity plugin move`, which rewrites references
and moves the config directories. The `cost-usage` data dir names its owner
only as a string, so the archive stays where it is. Today's `commitsConfig`
and `costConfig` values become the authored board `params`.

### Surfaces

- **Agent-manager Dashboard.** New plugin
  `apps/plugins/agent-manager/plugins/dashboard`. It holds the pane (route
  segment `dashboard`, title on `Pane.define`), the sidebar entry
  "Dashboard", and authored `config/…/dashboard/*.jsonc` with explicit ids
  for the Overview, Tasks, Spend and Code tabs. It imports only
  `metrics/web`, never a provider.
- **Debug.** Pushes becomes a `Profiling.Section` rendering a single-section
  Board over `push-metrics`. The responsiveness card becomes a
  `Profiling.Section` contributed by `debug/latency-ledger`; it is a plain
  move, since it has no charts. The "Profiling" chip goes away.
- **Later.** The DataView `dashboard` view type
  (`data-view/plugins/dashboard`) adds a second card source,
  `{ kind: "fields", time, measure: count | sum | active, split }`, which the
  core engine evaluates over client rows, or via a new
  `dataSource.aggregate` built on server-query `compileWhere`. DataView must
  newly give views `setOptions`, `setActiveView` and the lowered `filter`. The
  Pages `/chart` block (`page/plugins/chart-block`: `defineBlock` +
  `Editor.Block` + `Editor.BlockData` + a `config/page/editor/block.jsonc`
  entry) uses `MetricPicker` over the catalog.

### Enforcement

- **Type and check:**
  - `defineMetric` splits and params are `as const`; card refs are validated
    against the catalog at runtime.
  - A `metrics:board-refs` check resolves every committed board ref against
    the declared metrics.
  - Duplicate metric ids fail at collect time.
- **Lint:**
  - After P4, `recharts` imports are banned.
  - Inside metric sources, hand-rolled day keys are banned:
    `toISOString().slice(0, 10)` and `getUTC*` bucketing. Today
    `tasks/handle-daily.ts` and `cost/usage-index.ts` both do this.
    `core/intervals` is the one bucketing implementation.

### Footguns handled in `core/intervals` + engine

1. Shift the previous period in calendar units (days or weeks) via
   `packages/wall-clock`, not in milliseconds.
2. For **1Y**, compare to 53 weeks earlier so weekdays line up.
3. Clip the previous period's last bucket at `now − span`, so a partial
   current bucket is compared like-for-like; partial buckets are drawn
   distinctly.
4. A zero denominator gives `null`, not 0.
5. **"Open tasks at time T" is approximate.** There are no reopen events, and
   held tasks carry `heldAt`, not `finishedAt`. The level is computed from
   `createdAt` and the first of `finishedAt | droppedAt | heldAt`, and the
   metric description says so.

## Phases (→ sub-tasks)

| # | Task | Acceptance |
|---|---|---|
| P1 | `primitives/metrics` core + server + web, and `chart-kit` (port of the prototype), with a fake source in tests | bun: `intervals.test.ts` (Monday weeks, 1Y = 53 weeks, partial bucket, previous-period clipping, a DST zone for the tz path), `engine.test.ts` (level tile, rate tile, null coverage, compare only when unsplit). jsdom: bar count, tooltip, table fallback, dashed compare. Board renders loading states, and an error card for unknown refs |
| P2 | Move `stats/tasks` → `tasks/plugins/task-metrics`, `stats/cost` → `conversations/plugins/usage-cost`, `stats/commits` → `code-explorer/plugins/commit-metrics`, and rewrite them as metric sources. Add the agent-manager `dashboard` plugin and its four authored boards. Delete the interim live values the Stats charts read since B9 (see the next row): `stats.tasks.history`, `stats.commits.{counts,counts-by-category,lines,lines-by-ext}` and the five `stats.cost.*` keys (the old `/api/stats/{tasks,cost,commits}` endpoints are already gone) | No `stats.tasks.*`, `stats.commits.*` or `stats.cost.*` key remains. Numbers match the old charts over the same UTC days. A tab can be deleted and re-added from "+". Clicking a bucket opens the drawer with that bucket's tasks, conversations and commits. The prototype comparison (`compare-diff.ts --name proto-1790501215-euqp`) is close |
| P2/P3 (interim values) | Since the endpoint-reads migration (B9, `research/2026-10-11-global-endpoint-reads-onto-live.md`) no Stats chart reads an `/api/stats/*` endpoint; each reads an interim live value from its sub-plugin's `shared/values.ts`. **Tasks:** `stats.tasks.history` (one row per UTC day). **Commits:** `stats.commits.counts`, `stats.commits.counts-by-category`, `stats.commits.lines`, `stats.commits.lines-by-ext` (served from `commits/machine/`). **Cost:** `stats.cost.daily`, `stats.cost.sessions-daily`, `stats.cost.distribution`, `stats.cost.top-sessions` and the lookup collection `stats.cost.session-conversations` (served in `server/internal/served.ts`); the cost metric source reuses their one memoized bundle and its change signal (`watchCostInputs`). **Pushes:** `stats.pushes.wait-time`, `stats.pushes.throughput`, `stats.pushes.step-breakdown` (served from `pushes/machine/`). P2 deletes the tasks, commits and cost values with their plugins' moves; P3 deletes the pushes values with `push-metrics` | After P2: no `stats.tasks.*`, `stats.commits.*` or `stats.cost.*` key remains. After P3: no `stats.pushes.*` key remains |
| P3 | `push-metrics` + a pushes Profiling section; responsiveness → `latency-ledger` Profiling section; delete the interim `stats.pushes.{wait-time,throughput,step-breakdown}` live values; delete `plugins/stats` | Debug → Profiling shows both. No `@plugins/stats` imports and no `stats.pushes.*` key remain |
| P4 | health-monitor and deploy `trend-chart` move to `chart-kit`; delete `chart-primitives`; turn on the `recharts` lint; drop `recharts` from three package.json files | `./singularity check` is green |
| P5 | DataView `dashboard` view type + the three DataView additions + the `fields` card source; prove it on the tasks list | Filtering tasks changes the charts. A bar click filters the table and switches to it |
| P6 | Pages `/chart` block + `MetricPicker` | Insert via `/chart`, pick a metric, and it renders live. The block data survives a reload |

After approval, the vision summary goes into the Charts page
(`block-ddd8fe65-…`) as an agent note, and P1–P6 are filed with `add_task`
as a dependency chain.

## Verification

- `./singularity test plugins/primitives/plugins/metrics` (bun + jsdom) after P1;
  the provider tests after P2.
- `./singularity build`, then compare the old and new numbers: query
  `/api/metrics/query` for `tasks.completed` / `cost.spend` / `code.commits`
  over 30D and diff against the old `/api/stats/*` responses, captured before
  the deletion, for the same UTC days.
- Screenshots via `e2e-harness/e2e/screenshot.ts --path /agents/dashboard`
  (each tab, dark and light), and `compare-diff.ts` against the prototype.
- `./singularity check` covers boundaries, `metrics:board-refs`,
  `config-stable-list-ids` and the lints.

## Critical files

- New: `plugins/primitives/plugins/metrics/**`.
- Reused:
  - `plugins/framework/plugins/server-core/core/contributions.ts`
    (`defineServerContribution`)
  - `plugins/primitives/plugins/data-view/plugins/view-core/web`
    (`buildViewDescriptors`, `buildViewConfigContributions`, `useViewModel`,
    `EditableViewSwitcher`, `AddViewMenuItems`)
  - `plugins/primitives/plugins/outline/plugins/rail/web` (`OutlineRail`)
  - `plugins/packages/plugins/wall-clock/core`
  - `plugins/primitives/plugins/persistent-draft/web` (`useDraft`)
  - `plugins/network/plugins/live` (`liveValue`)
  - `plugins/infra/plugins/endpoints` (`fetchEndpoint`)
- Moved or rewritten: `plugins/stats/**` (deleted at the end),
  `plugins/stats/plugins/cost/server/internal/{archive,usage-index,load-usage,price-table,refresh-job}.ts`
  (kept, relocated), `plugins/stats/plugins/commits/server/internal/commit-timestamps.ts`,
  `plugins/stats/plugins/pushes/server/internal/read-pushes.ts`.
- Touched later:
  - `plugins/debug/plugins/profiling/web/slots.ts` (`Profiling.Section`)
  - `plugins/debug/plugins/latency-ledger/web`
  - `plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx`
  - `plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard/web/components/trend-chart.tsx`
