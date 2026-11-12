# dashboard

The deploy app's Analytics section on a deployment's page. It runs collect's
report on this computer's copy of the deployed site's analytics tables and
renders it; it stores nothing of its own.

## Reading the report

The `deploy-analytics.report` live value (`core/internal/analytics.ts`) — a
typed-query value, question `{ deploymentId, query }` — is served external,
`changes: "notified"` (`server/internal/served.ts`). Its loader is collect's
own `runAnalyticsQuery` — no second implementation — run through
site-mirror's `readSiteMirror(deploymentId, "analytics", (tx, { sourceNow }) => …)`:
inside `withReplicaSchema`'s read-only snapshot of the replica (`search_path`
= the copy's schema, then `pg_catalog`, so collect's unqualified tables are the
site's and a table the set does not mirror fails instead of reading this
computer's own), **as of the box's clock at the last page applied**
(`sourceNow`), never this computer's. The report is then exactly what the box
would have answered at that moment, today's partial day and the live-visit
cutoff included.

- **Pushed.** `whileSubscribed` subscribes `onSiteMirrorApplied` for the
  deployment: each page the replica commits (NOTIFY `table_mirror`) recomputes
  its tuples, throttled to one a second. The replica's state and copy are its
  declared `reads.notified`; the deployment row (refused `missing` once
  deleted) its `reads.tables`.
- **Not copied yet is pending.** Until a whole first copy is in place (or
  while no replica exists — no tab asked for the set yet) the answer is
  `not-copied`, rendered as loading beside the freshness line, never as an
  empty report.
- **Freshness.** Site-mirror's `<MirrorFreshness>` sits above the dashboard
  (and in the Overview's Traffic card, and in an Overview card while the copy
  is not readable): when the copy was synced, Sync now, and why a pull failed
  (SSH, an older release). Opening it asks for a pull when the copy is stale —
  there is no Refresh of the report itself.

The answer is a discriminated result, never an empty report: `report` /
`refused` (collect's own result) or `not-copied`. A missing deployment is
refused `missing` (the read's error arm, through `ResourceErrorInline`).

**Question size.** A question must fit `LIVE_QUERY_MAX_BYTES` (2 KiB): the
id is capped at 128 chars and the filters, as canonical JSON, at
`FILTERS_MAX_BYTES` (1536) — a refine in the question schema and `filtersFit`,
the one rule `clickRow` checks before it adds or replaces a filter (a row that
would not fit is disabled with the reason). A test pins the worst case under
the limit.

## When the section shows

`useShipsAnalytics` asks host-query's `useDeploymentShips` (over
`plugin-meta/composition`'s `useCompositionIncludes`) whether the deployment's composition resolves to a closure containing the collect
plugin (collect's own `COLLECT_PLUGIN_ID`, pinned to its folder by a test there); the tab gate is host-query's shared `useShipsGate`, the same rule as the Sessions tab's. No
composition is ever named. Loading keeps the card (with a loading body); a
composition without collect hides it.

## The dashboard

Range, comparison, filters, chart metric and panel tabs are local state; each
change is a new question — a new tuple of `useLive(deploymentAnalytics, …)`,
loading until it is computed from the local copy; it moves when the copy syncs.

Filter rules live in `web/internal/filters.ts`: clicking a row adds its filter,
replaces another value of the same dimension, or removes its own. When
`reportSourceFor` says `totals` (the range reaches past the 90-day raw window),
a second filter is refused before asking and the chip bar says why in one line;
a raw report stacks at most collect's `MAX_FILTERS` (8). A `refused` answer (e.g. the range was widened with two filters on) renders as
an error with "keep only the first filter".

The **Visitors / You / All** switch picks the question's audience (collect's
CLAUDE.md § The owner's own visits); Visitors is the default, so the owner's
own reading never counts. On a range past the raw window only Visitors can be
answered — the refusal offers "Show visitors". The Overview's **Your devices**
card (`owner-devices-card.tsx`) carries the mark link and its QR code (`uqr`,
drawn dark-on-light whatever the theme, for phone cameras).

Panels are ranked top-N readouts of one fetched report, rendered as `Row`s with
a named `no-adhoc-row-list` disable: the order is the server's ranking and each
row is a filter toggle. "What one visit records" renders collect's
`RECORDED_FIELDS` / `NEVER_RECORDED`.

A row and its filter chip show a value through `dimensionValueLabel`
(`web/internal/format.ts`): a per-dimension label map, identity by default —
countries read "France (FR)" via `Intl.DisplayNames` in `navigator.language`. The stored value is still
what is filtered on. A tab can carry a `credit` (its data source, linked),
rendered after its note; Countries credits `IP_COUNTRY_SOURCE`.

## Tests

- Report parity — the same report on the box's tables and on the copy — is
  collect's (`analytics.db.test.ts`, *mirror parity*).
- `core/internal/analytics.test.ts` — a question within the filters budget
  always fits `LIVE_QUERY_MAX_BYTES`; over it, the schema refuses.
- `web/__tests__/filter-rules.test.tsx` — the chip rules (incl. the filter cap
  and the size budget), as rule and as UI;
  country labels and the Countries credit.
- `web/__tests__/dashboard-states.test.tsx` — loading, not copied yet
  (loading, never empty), a refused read, each refusal, and a report's panels
  (Countries rows + credit).

Run with `./equin test plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Analytics tab of a site's page, shown only when the deployment's composition ships the collect plugin: range and comparison controls, KPI tiles choosing a trend line with a dashed previous period, ranked Pages / Sources / Locations / Devices / Events panels whose rows filter the whole dashboard (one filter on ranges past the raw window), and what one visit records. Reads the report computed from this computer's copy of the site's tables (pushed as the copy syncs), under the copy's freshness line; loading until a first copy is in place, an explicit state for a refusal or a failed read. Serves a deployment's analytics report: collect's own runAnalyticsQuery run on this computer's copy of the site's analytics tables (site-mirror's readSiteMirror, as of the box's clock at the last page synced), pushed on each page the copy applies — report, refused, or not-copied while no whole first copy is in place (rendered as loading).
- Web:
  - Contributes:
    - `SiteTabs.View` "Analytics" → `AnalyticsSection`
    - `SiteOverview.Card` "traffic" → `TrafficCard`
    - `SiteOverview.Card` "top" → `TopCards`
    - `SiteOverview.Card` "owner-devices" → `OwnerDevicesCard`
  - Uses: 40 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/deploy/deployments` ×6
    - `apps/deploy/host-query` ×4
    - `primitives/css/coords` ×2
    - `primitives/css/text` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/link-gesture` ×2
    - `apps/deploy/site-mirror/pull.MirrorFreshness`
    - `network/live/live-state.ResourceErrorInline`
    - `network/live.useLive`
    - `primitives/collapsible.FoldMotion`
    - `primitives/css/badge.Badge`
    - `primitives/css/card.Card`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.Rigid`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/switch.Switch`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture/new-tab.NewTabLink`
    - `primitives/loading.Loading`
    - `ui/icons.Icon`
- Server:
  - Contributes: `resource.declare` "deploy-analytics.report"
  - Uses:
    - `apps/deploy/analytics/collect.analyticsMirrorTables`
    - `apps/deploy/analytics/collect.runAnalyticsQuery`
    - `apps/deploy/deployments._deployDeployments`
    - `apps/deploy/site-mirror/pull.onSiteMirrorApplied`
    - `apps/deploy/site-mirror/pull.readSiteMirror`
    - `database.db`
    - `database/table-mirror/replica.tableMirrorReplicas`
    - `network/live.serveValue`
  - Resources: `deploy-analytics.report` (push, notified)
- Core:
  - Uses:
    - `apps/deploy/analytics/collect.AnalyticsFilter`
    - `apps/deploy/analytics/collect.AnalyticsQueryResultSchema`
    - `apps/deploy/analytics/collect.AnalyticsQuerySchema`
    - `network/live.liveValue`
    - `network/live/canonical-params.canonicalJson`
  - Exports (types): `DeploymentAnalyticsResult`
  - Exports (values):
    - `deploymentAnalytics`
    - `filtersFit`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/chart --chart-1`
    - `ui/tokens/chart --chart-3`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/color-palette --popover-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/density --control-height-xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
- Test helpers:
  - Web: `@plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard/web/testing`
    - `metrics`
    - `report`
    - `row`

<!-- AUTOGENERATED:END -->
