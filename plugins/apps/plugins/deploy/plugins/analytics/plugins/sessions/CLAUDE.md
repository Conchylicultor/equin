# sessions

The deploy app's **Sessions** tab on a site's page, right after Analytics: one
row per anonymous visit of the deployed site — who (country, time, device,
software, source, first visit or returning, channel), its **journey** on a
shared log time axis, how long it lasted and how many actions it held — and,
opened, the visit's timeline. Timeline only: no session replay. Design:
`research/2026-11-10-deploy-sessions-tab.md` (phase 1); pixel reference
`proto-1794248902-aof7vs`.

## Reading the visits

`deploy-analytics.sessions` (`core/internal/sessions.ts`) is a window
`liveCollection` declared by its own fields (the visit's columns, its
duration, its `pages` / `eventNames` memberships — labelled, so the DataView
filters, groups and sorts on them — plus the carried lane data: hits, lastAt,
…). Row key `key` = `<deploymentId>/<visit id>` (`sessionKey`); sorted by
`startedAt` alone (`$key` text `toISOString()`), the id ascending breaking
ties; page 50, `maxLimit` 100, `count: true`.

Served `source: "external"` (`server/internal/served.ts`) on this computer's
**copy** of the site's analytics tables (`apps/deploy/site-mirror`'s replica,
`readSiteMirror`) — never over SSH:

- **One site per read.** A window has no params, so every question names its
  site as a top-level `deploymentId = <site>` clause (`clause("deploymentId", "eq", id)`)
  and `splitScope` takes it off; a read naming none, or two, throws.
- **collect's SQL, no second implementation**: `readVisitWindow` /
  `readVisitsById` / `readVisitGroups` / `countVisits` (collect's server
  barrel) run on the replica's schema, the rest of the filter compiled by
  collect (`filterSql` over its visit columns, the report's duration and
  membership definitions).
- **"Live" is the copy's moment**: a visit is still open relative to the box's
  clock at the last applied page (`withReplicaSchema`'s `sourceNow`), never
  this computer's clock.
- **Freshness**: `changes: "notified"`, `whileSubscribed` = the replica's own
  NOTIFY (`onSiteMirrorApplied("analytics")`), so a pull landing re-reads every
  held window (the replica schema is outside the change feed — this plugin's
  `no-db-backed-notify` exemption).
- **Not copied yet is loading.** The tab mounts the list only once
  `site-mirror.status` says the analytics set is `copied`; a read before that
  throws (a broken assumption, never an empty list).

## The tab

- **Gate**: `useShipsGate(deploymentId, COLLECT_PLUGIN_ID)` — host-query's one
  rule over collect's own id, the same as the Analytics tab's.
- **Freshness line** above the list: site-mirror's `MirrorFreshness` (synced
  N ago · Sync now, copying…, a failed pull in host-query's words); opening
  the tab asks for a pull when the copy is missing or a few minutes old.
- **List**: a `DataViewSwitcher` (`deploy-sessions`) over ONE contributed
  source, `visits` (`SessionsSources`), so the loaded rows are in hand: the
  source reads `useLivePagesPaging(deploymentSessions, { where: clause("deploymentId", "eq", id) },
  { narrowBy: view, total: true })` — the active view's filter runs on the
  server (collect's SQL on the copy), its count is the summary's total — and
  derives the `LaneWindowContext` from the loaded window before handing the
  bundle on. The exhibit feeds the same source made-up rows
  (`SessionsHostProps.kind: "fixture"`).
- **Views = the shapes** (`config/apps/deploy/analytics/sessions/deploy-sessions.jsonc`):
  All / With actions (`events > 0`) / 2+ pages (`pageviews ≥ 2`) / Bounced
  (`pageviews = 1`, the report's bounce), each a saved filter that also starts
  on the site's visitors (`owner is false`). No date range: the list pages
  back through time as it scrolls.
  `viewEdits: draft`: changing whose visits or the device (or any other rule)
  is a draft of the view, and the drafted view rides in the URL
  (`;view.deploy-sessions=<id>~<draft>`, view-core's addressable drafts).
  The active view is in the URL too.
- **Search** filters the loaded rows in memory (country, source, software,
  pages).
- **Toolbar**: its own arrangement (`sessionsToolbar`): the summary on its
  own line (sessions = the view's count; median duration, median load and
  "with actions" over the LOADED visits), then the standard DataView toolbar
  (`PillsToolbar`: views pill, tools pill — search, Filter / Sort / View — and
  the quick filters on the row under them) — and the axis row, all in the
  sticky band.
- **Quick filters** (data-view `quickFilters`, declared in the `visits`
  bundle): whose visits — Visitors (`owner is false`) / You (`is true`) / All
  (no rule) — and the device — Any device (no rule) / Desktop / Mobile /
  Tablet (`device is <family>`, collect's `DEVICE_FAMILIES`). Each is a
  top-level rule of the active view's filter, so the saved views
  (`r-visitors`) read as Visitors + Any device, and a pick is a draft carried
  in the URL; a hand-edited rule
  selects no segment.
- **Rows**: the list view's `renderRow` (`SessionLane`) and `detail`
  (`SessionTimeline`), with `detailOnActivate` and `frame: "card"`; a row is
  handed to them as collect's `Session` (`sessionOf`, kept per row object).
- **Window**: `LaneWindowContext` carries what every row shares, derived once
  per loaded window: each visit's journey, the axis' end, each path's
  estimated sections (for pages that did not record their own), the summary.

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

`web/internal/axis.test.ts`, `web/internal/journey.test.ts`,
`server/internal/served.test.ts` (the scope split); collect's
`analytics.db.test.ts` covers the SQL. Run with
`./equin test plugins/apps/plugins/deploy/plugins/analytics/plugins/sessions`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Sessions tab of a site's page, shown only when the deployment's composition ships the collect plugin: one row per anonymous visit (country, time, device and software, source, first visit or returning, channel), its journey on a shared log time axis (pages split by their share of the visit, the read line and section ticks, action icons, each named on hover) with its duration and actions; opening a row shows its timeline (each page, the sections reached and when, the actions in order, the exit). Read from this computer's copy of the site's analytics (site-mirror, its freshness line above the list; loading until a first whole copy is in place) as live key-range pages: the views (All / With actions / 2+ pages / Bounced) are saved filters, and every filter — whose visits, the device, any field — runs on the copy, a narrowed view carried in the URL. Serves a deployment's visits (deploy-analytics.sessions) from this computer's copy of the site's analytics tables (site-mirror's replica): collect's own visit-list SQL — the window, the rows by key, the groupings and the count, each filter compiled by collect — run on the copy, re-read whenever a pull applies a page to it.
- Web:
  - Slots: `sources`
  - Slot contributors: `sources` ← `apps.deploy.analytics.sessions`
  - Contributes:
    - `SiteTabs.View` "Sessions" → `SessionsSection`
    - `sources` "Visits" → `VisitsSource`
  - Uses: 39 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×8
    - `primitives/css/ui-kit` ×5
    - `primitives/css/coords` ×4
    - `apps/deploy/host-query` ×3
    - `network/live/live-state` ×2
    - `primitives/css/spacing` ×2
    - `apps/deploy/deployments.SiteTabs`
    - `apps/deploy/site-mirror/pull.MirrorFreshness`
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
    - `primitives/css/yield.yieldClass`
    - `primitives/loading.Loading`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `resource.declare` "deploy-analytics.sessions"
    - `resource.declare` "deploy-analytics.sessions:count"
    - `resource.declare` "deploy-analytics.sessions:groups"
    - `resource.declare` "deploy-analytics.sessions:rows"
  - Uses:
    - `apps/deploy/analytics/collect.analyticsMirrorTables`
    - `apps/deploy/analytics/collect.countVisits`
    - `apps/deploy/analytics/collect.readVisitGroups`
    - `apps/deploy/analytics/collect.readVisitsById`
    - `apps/deploy/analytics/collect.readVisitWindow`
    - `apps/deploy/analytics/collect.VisitReads`
    - `apps/deploy/site-mirror/pull.onSiteMirrorApplied`
    - `apps/deploy/site-mirror/pull.readSiteMirror`
    - `database/table-mirror/replica.tableMirrorReplicas`
    - `network/live.serveCollection`
  - Resources:
    - `deploy-analytics.sessions` (keyed, window)
    - `deploy-analytics.sessions:count` (push)
    - `deploy-analytics.sessions:groups` (push)
    - `deploy-analytics.sessions:rows` (keyed, point)
- Core:
  - Uses: 21 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/deploy/analytics/collect` ×9
    - `fields/text/config` ×2
    - `network/live` ×2
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/duration/config.durationField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/string-list/config.stringListField`
    - `fields.nullable`
    - `packages/list-bound.cappedList`
  - Exports (types): `SessionRow`
  - Exports (values):
    - `deploymentSessions`
    - `parseSessionKey`
    - `sessionKey`
    - `sessionOf`
    - `sessionRowOf`
    - `startedAtKeyText`
- Cross-plugin:
  - Uses tokens: 28 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×14
    - `ui/tokens/density` ×9
    - `ui/tokens/type-scale` ×3
    - `ui/tokens/shape` ×2
- Exemptions:
  - Exempts itself from: `no-db-backed-notify` — `server/internal/served.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
