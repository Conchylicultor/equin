# sessions

The deploy app's **Sessions** tab on a site's page, right after Analytics: one
row per anonymous visit of the deployed site — who (country, time, device,
software, source, first visit or returning, channel), its **journey** on a
shared log time axis, how long it lasted and how many actions it held — and,
opened, the visit's timeline. Timeline only: no session replay. Design:
`research/2026-11-10-deploy-sessions-tab.md` (phase 1); pixel reference
`proto-1794248902-aof7vs`.

## Reading the visits

`deploy-analytics.sessions` (`core/internal/sessions.ts`) is a **key-range
paged** live value with `load: "snapshot"` (network/live, *Snapshot pages*):
question `{ deploymentId, range, shape }`, items collect's `Session`, key
`[startedAt, id]` both **desc** — collect orders `(started_at desc, id desc)`,
and the primitive's own tie-break (id ascending) would disagree with the box on
two visits started in the same millisecond. Page `limit` 50, `maxLimit` 100
(collect's `SESSIONS_PAGE` / `MAX_SESSIONS_LIMIT`).

Served external with `changes: { snapshot }` (`server/internal/served.ts`):
each page is ONE `hostOnlyQueryOverSsh` call of collect's host-only sessions
query, its cuts mapped to collect's `after` / `until` (`sessionsQueryOf`).
Pages are measured when the list first needs them (page 0 on mount, the next
as it scrolls — DataView's auto-paging, `useLivePagedValuePaging`) and
re-measured by Refresh; never on a timer (each is an SSH session).

The **meta** sibling (`deploymentSessions.meta`, the same question) is a
`limit: 1` ask whose answer is a discriminated state: `sessions` (the counts
per shape over the whole range, and when the box answered), `refused`
(`beyond-raw-window`), or one of host-query's failure arms. The tab renders the
failure from the meta (`HostQueryFailureState`); a page that cannot be read is
refused `unreachable` / `missing` / `beyond-raw-window` — an expected answer,
never reported as a loader failure.

## The tab

- **Gate**: `useShipsGate(deploymentId, COLLECT_PLUGIN_ID)` — host-query's one
  rule over collect's own id, the same as the Analytics tab's.
- **Range** (Today / 7d / 30d — collect's ranges inside the 90-day raw window)
  and **shape** (All / With actions / 2+ pages / Bounced, each with its count
  from the meta) are the server question; the search filters the loaded rows.
- **List**: a `DataView` (`deploy-sessions`, its one view authored in
  `config/apps/deploy/analytics/sessions/`: newest first, grouped by day),
  through the list view's `renderRow` (`SessionLane`) and `detail`
  (`SessionTimeline`), with `detailOnActivate` (a click opens the timeline)
  and `frame: "card"` — both list options added for this surface.
- **Toolbar**: its own arrangement (`sessionsToolbar`): search, the shape
  switch, the summary (sessions = the meta's count; median duration and "with
  actions" over the LOADED visits), and the axis row — in the sticky band, so
  the ticks stay over the bars while visits scroll under them.
- **Window**: `LaneWindowContext` carries what every row shares, derived once
  per loaded window: each visit's journey, the axis' end, each path's
  estimated sections (for pages that did not record their own).

## The journey (pure, `web/internal/`)

- `axis.ts` — `axisFrac(s, max) = log1p(s/4) / log1p(max/4)`, `max =
  max(longest loaded visit, 1 h)`, ticks 10s · 30s · 1m · 5m · 15m · 1h · 2h.
  The bar's length is the visit on the axis; inside it pages split it LINEARLY
  by their share (`pageShares`) — mapping each page through the log would
  squeeze late pages.
- `journey.ts` — `journeyOf(session)`: a page lasts until the next pageview,
  the exit page until the visit's end (`durationMs` — collect's one definition
  of a visit's duration, background included; never re-derived here, so a
  visit lasts as long in the tab as in the report); events belong to the
  pageview before them; `section_reach` hits (collect's `SECTION_REACH_EVENT`,
  section `<page>/<key>`) become the page's reached sections (first reach
  only), the rest its actions. "Read %" (`pageRead`) = sections reached ÷ the
  page's own recorded section list (collect's pageview `sections`, page order)
  — every section drawn in the depth bar, unreached ones greyed. A pageview
  without one (an older tracker, no beacon), or whose list misses a section the
  visitor reached, falls back to the estimate — the sections any loaded visit
  reached on that path (`sectionsByPath`, mean reach order) — and is shown as
  estimated (`~60% read`, a fainter read line, a note in the timeline): it
  overstates, and moves as visits load.
- `events.ts` — the website's event names in words, with an icon; an unknown
  event still renders, by its name.

Background / idle stretches and load time are recorded but not drawn yet
(task-1794273264-vx579h).

## Tests

`web/internal/axis.test.ts`, `web/internal/journey.test.ts`. Run with
`./equin test plugins/apps/plugins/deploy/plugins/analytics/plugins/sessions`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Sessions tab of a site's page, shown only when the deployment's composition ships the collect plugin: one row per anonymous visit (country, time, device and software, source, first visit or returning, channel), its journey on a shared log time axis (pages split by their share of the visit, the read line and section ticks, action icons, each named on hover) with its duration and actions; opening a row shows its timeline (each page, the sections reached and when, the actions in order, the exit). Range, shape switch with per-shape counts, search over the loaded visits; read over SSH as key-range pages that load as the list scrolls. Reads a deployment's visits over SSH through host-query's hostOnlyQueryOverSsh (collect's host-only sessions query, curled through the install's own gateway), one key range per page, and their per-shape counts — or which of SSH, the request or the answer failed.
- Web:
  - Contributes: `SiteTabs.View` "Sessions" → `SessionsSection`
  - Uses: 40 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/deploy/host-query` ×5
    - `primitives/css/ui-kit` ×5
    - `primitives/data-view` ×5
    - `primitives/css/coords` ×4
    - `network/live/live-state` ×2
    - `primitives/css/spacing` ×2
    - `apps/deploy/deployments.SiteTabs`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/clip.clipClasses`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/css/yield.yieldClass`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/relative-time.RelativeTime`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `resource.declare` "deploy-analytics.sessions"
    - `resource.declare` "deploy-analytics.sessions:meta"
  - Uses:
    - `apps/deploy/host-query.hostOnlyQueryOverSsh`
    - `apps/deploy/host-query.HostQueryAnswer`
    - `infra/endpoints.endpointPath`
    - `network/live.serveValue`
  - Resources:
    - `deploy-analytics.sessions` (invalidate, snapshot)
    - `deploy-analytics.sessions:meta` (invalidate, snapshot)
- Core:
  - Uses:
    - `apps/deploy/analytics/collect.AnalyticsRangeSchema`
    - `apps/deploy/analytics/collect.MAX_SESSIONS_LIMIT`
    - `apps/deploy/analytics/collect.RAW_RETENTION_DAYS`
    - `apps/deploy/analytics/collect.SessionCountsSchema`
    - `apps/deploy/analytics/collect.SESSIONS_PAGE`
    - `apps/deploy/analytics/collect.SessionSchema`
    - `apps/deploy/analytics/collect.SessionShapeSchema`
    - `apps/deploy/host-query.HOST_QUERY_FAILURE_ARMS`
    - `network/live.liveValue`
  - Exports (types):
    - `DeploymentSessionsMeta`
    - `DeploymentSessionsQuestion`
  - Exports (values):
    - `deploymentSessions`
    - `DeploymentSessionsMetaSchema`
    - `DeploymentSessionsQuestionSchema`
- Cross-plugin:
  - Uses tokens: 28 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×14
    - `ui/tokens/density` ×9
    - `ui/tokens/type-scale` ×3
    - `ui/tokens/shape` ×2

<!-- AUTOGENERATED:END -->
