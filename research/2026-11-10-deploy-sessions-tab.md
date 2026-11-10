# Deploy — Sessions tab (one row per anonymous visit)

Prototype: `proto-1794248902-aof7vs` (pixel reference for the UI; its replay was
dropped — the app ships the timeline only).

## Context

The deployed site's analytics (`apps/deploy/analytics`) answer aggregate
questions — top pages, sources, events — but not "what did people actually do":
which pages, in what order, how long, what they clicked, where they gave up.
The raw rows already hold most of that (`analytics_visits` + `analytics_hits`,
90 days), yet nothing lists individual visits.

Goal: a **Sessions** tab on a site's page, next to Analytics (its own tab, one
click away), where each row is one visit: who (country, device, source,
returning), its **journey** on a shared log time axis (pages as segments, actions
as icons, how far each page was read), duration, actions, and load time. Opening
a row shows the visit's timeline in detail.

Two signals the rows need are not recorded today, and are added:

- **Away stretches** — when the tab was in the background, or visible but idle.
  Without them a 1 h "visit" left open in a tab reads like an hour of reading.
- **Load time** of the page load — server response, first paint, ready.

No session replay, no cursor or DOM recording, no new identifier: the privacy
model of `collect` (cookieless, salted daily hash, IP never stored) is unchanged.

## Phases

Each phase ships on its own; the tab is useful after phase 1.

1. **Sessions tab on today's data** — query + tab + rows + detail.
2. **Away stretches** — tracker records them, `collect` stores them, the UI shades them.
3. **Load time** — tracker sends boot timing, `collect` stores it, the UI shows it.

Rows recorded before phase 2/3 reached a deployment have no stretches / no load
timing: that is a *not recorded* state, drawn as such (no chip, no "active"
line) — never as "0 s away" or "loaded in 0 s".

## Phase 1 — the Sessions query and tab

### Collect (ships on the box): `apps/deploy/analytics/collect`

New host-only endpoint beside `analyticsQueryEndpoint` (`core/internal/endpoints.ts`):

- `analyticsSessionsEndpoint`: `GET /api/host-only/analytics/sessions?q=<base64url>`,
  same encoding as `encodeAnalyticsQuery` (`core/internal/query.ts`) — add an
  `encodeSessionsQuery` / `SessionsQueryParamSchema` pair next to it, sharing the
  base64url helpers.
- `SessionsQuery` (core): `{ range: AnalyticsRange, filters: AnalyticsFilter[]
  (reuse AnalyticsFilterSchema, max 8), shape: "all" | "actions" | "multi" |
  "bounced", after?: SessionKey, until?: SessionKey, limit }`, where
  `SessionKey = { startedAt, id }`. Ranges reaching past the raw window
  (`sessionsAvailableFor`, i.e. `12m`) are refused
  (`{ kind: "refused", reason: "beyond-raw-window" }`) — sessions exist only as
  raw rows.
- **Paging contract** (agreed with the paged-snapshot task,
  task-1794273213-zfgiv9): the order is `(started_at desc, id desc)`; one
  answer is ONE key range of it — `after` exclusive, `until` inclusive, at most
  `limit` rows (1..`MAX_SESSIONS_LIMIT` = 100 = 2 × `SESSIONS_PAGE` 50, a split
  page). No `next` cursor: the client mints cuts from the rows' own keys, and
  an answer shorter than `limit` is the end. A cut's own row may be gone; the
  key still bounds. `startedAt` is spelled as `toISOString()` (fixed width,
  UTC, ms — what collect stores), so its text order is its time order.
- Result: `{ kind: "sessions", generatedAt, sessions: cappedList(MAX_SESSIONS_LIMIT),
  counts: { all, actions, multi, bounced } }` — `counts` over the whole range
  and filters, independent of shape / after / until / limit (a `paged.meta`
  read can ask with `limit: 1`). Each session: the visit's columns (minus
  `visitor_id`, which leaves the box only as `visitor`, the first 8 hex of its
  sha256) + `durationMs` (the report's) + `live` (still inside the 30-min
  visit cutoff; a closed visit never changes) + `hits: cappedList(MAX_SESSION_HITS
  = 200)` of `{ ts, kind, path, eventName, eventProps, engagedMs }` +
  `hitsTruncated`.
- Server `server/internal/sessions.ts`: one query over `analytics_visits`
  (`started_at desc, id desc`, key range `(after, until]`), filters through the SAME
  membership SQL the report uses (`aggregate-sql.ts`, a hit-dimension filter
  keeps visits having such a hit) — no second filter dialect; then the window's
  hits in one `visit_id = ANY(...)` read ordered by `ts`. Wired in `routes.ts`
  as `hostOnly(implement(analyticsSessionsEndpoint, …))`.

### Dashboard side (local app): new plugin `apps/deploy/analytics/sessions`

- **core**: `deploymentSessions = liveValue("deploy-analytics.sessions",
  { query: { deploymentId, query: SessionsQuery }, load: "snapshot",
  refusals: ["missing"], schema: SessionsResult | HOST_QUERY_FAILURE_ARMS })` —
  modelled on `deploymentAnalytics` (`dashboard/core/internal/analytics.ts`).
  The question stays under `LIVE_QUERY_MAX_BYTES` (reuse `filtersFit`).
- **server**: `serveValue(..., { source: "external", changes: { snapshot } })`
  whose loader is one `hostOnlyQueryOverSsh` call (`host-query/server`) — a copy of
  `dashboard/server/internal/served.ts`'s shape. Measured on mount and on
  Refresh, never on a timer.
- **Paging**: the list auto-pages like every DataView (grows as you scroll).
  Today `network/live` refuses `paged` on a `snapshot` value ("Snapshot never
  with preload / paged"). Sessions are keyed by `(started_at, id)` desc, and a
  visit older than the 30-min live cutoff never changes, so a key-range page is
  well defined: extend `network/live` (prerequisite task) so an external value
  with no change signal can be paged — each page measured when it is first
  needed, Refresh re-measuring the loaded pages — and DataView's auto-paging
  works on it unchanged. No Older / Newer buttons.
- **web**: `SiteTabs.View({ id: "sessions", title: "Sessions", icon:
  symbol("timeline"), component: SessionsTab, useAvailable })`, placed after
  Analytics in `config/apps/deploy/deployments/site-tabs.jsonc`. `useAvailable`
  is the same "ships collect" gate the Analytics tab uses
  (`dashboard/web/internal/use-analytics-available.ts`) — move that hook to a
  place both can import (e.g. `host-query/web` or `analytics/collect/core` id +
  a shared hook) rather than importing across dashboard → sessions.
- **List**: a `DataView` over the window's rows (in-memory origin: `rows`,
  `readiness={result}`, `rowKey`), `views={["list"]}`, `groupBy` day,
  `viewOptions.list.renderRow` = the session lane, row expansion for the detail.
  Search filters the loaded window client-side; the shape filter (All / With
  actions / 2+ pages / Bounced) and the range are the server question. Needs a
  `defineDataView("deploy-sessions")` key and its authored
  `config/…/deploy-sessions.jsonc`. **Check first** that list `renderRow` + row
  detail cover the lane and the expanded timeline; if not, extend DataView
  rather than hand-rolling a `.map()`.
- **Components** (web/components): `SessionLane` (facts · journey · duration),
  `JourneyBar` (segments, section ticks, read line, action icons, hover tip),
  `TimeAxis` (sticky ticks row), `SessionTimeline` (expanded detail: page cards,
  depth bar with section reach times, actions in order, exit). Event icons and
  labels come from a small map keyed by event name with a generic fallback
  (unknown events still render, by name).
- **Axis math** in `web/internal/axis.ts` (pure, tested): `axisFrac(s, max)` =
  `log1p(s/4) / log1p(max/4)`, ticks 10s · 30s · 1m · 5m · 15m · 1h · 2h,
  `max = max(longest in window, 1 h)`. Bar length = total time on the axis;
  pages split the bar by their share (not log-mapped inside — late pages would
  be squeezed).
- **Page time** = next hit's `ts` − this pageview's `ts` (exit page: its
  `engagedMs`, i.e. `exit_engaged_ms`). "Read %" = distinct `section_reach`
  sections of that page ÷ sections seen anywhere for that page in the window —
  the box does not know a page's full section list. *(Open: record the page's
  section count with the pageview so read % is exact — see Follow-ups.)*

## Phase 2 — away stretches

### Tracker (`collect/web/internal/tracker.ts`, `instance.ts`)

- `CurrentPage` gains `gaps: { startMs, endMs, kind: "hidden" | "idle" }[]`,
  offsets from the pageview's start (`deps.now()` at `pathChanged`).
- **hidden**: opened on `hidden()`, closed on `visible()` — the existing
  visibility hooks.
- **idle**: visible, no `pointermove|pointerdown|keydown|wheel|scroll|touchstart`
  for `IDLE_AFTER_MS = 30_000` and no playing `<video>/<audio>`. Inputs are
  passive listeners that re-arm ONE deadline timer (a deadline, not a poll); the
  stretch starts at the last input, ends at the next input.
- Sent with the existing engagement body (no new requests): `gaps` replaces the
  stored list each time (cumulative, like `engagedMs`), capped at
  `MAX_GAPS = 20` per pageview (merge the shortest neighbours past the cap) so
  the body stays under `MAX_COLLECT_BODY_BYTES`. Stretches under 5 s are dropped.
- `TrackerDeps` gains `onInput` / `setDeadline` / `isMediaPlaying` so the logic
  stays injected and unit-testable.

### Collect

- `EngagementBodySchema` gains `gaps?: cappedList(MAX_GAPS)` (schema is `.strict()`).
- `analytics_hits.gaps`: `parsedJson(GapsSchema)`, nullable — **null = not
  recorded** (old tracker / old rows), `[]` = recorded, none. Migration by
  `./equin build`; add it to `RECORDED_FIELDS` (`core/internal/recorded-fields.ts`,
  tsc-checked against the columns) so "What one visit records" lists it.
- `recordEngagement` writes `gaps` when the body's `engagedMs` is the newer total
  (same monotonic rule as `engaged_ms`).
- Sessions result carries `gaps` per pageview hit.

### UI

- Shading in `JourneyBar` (background = emptied bar with a dashed line; idle =
  hatch), legend in the axis row, `Xm active` under the duration, gap entries in
  the expanded timeline. Exactly the prototype.

## Phase 3 — load time

- Tracker reads `boot-trace` (`primitives/perfs/boot-trace/web`:
  `getBootTrace`, `subscribeBootTrace`, `bootWindowEnd`) once per page load:
  `ttfbMs = navigation.responseStartMs`, `fcpMs = paint.firstContentfulPaintMs`,
  `readyMs = bootWindowEnd(trace)`. FCP lands after mount, so wait on
  `subscribeBootTrace` until FCP (or first hide, whichever first); unsupported
  paint timing → `fcpMs: null`.
- Sent once, on the first engagement of the page load: `load?: { ttfbMs, fcpMs,
  readyMs }` on `EngagementBodySchema`. No extra request.
- Stored on the pageview hit that was the hard load: `analytics_hits.load`
  (`parsedJson`, nullable = not recorded / not a hard load). A visit may contain
  several hard loads (reloads); the row shows the first.
- UI: load chip on the row (green < 1.5 s · amber < 3 s · red), the
  server → first paint → ready bar in the expanded timeline, median load in the
  summary — as in the prototype.
- Verify the deployed website composition boots through `web-core` (which
  imports boot-trace) before relying on it.

## Privacy

Nothing identifying is added: stretches and timings are durations. The visitor
id stays on the box; the tab shows a short display hash. Retention unchanged
(raw 90 days, cascade with the visit). The site's privacy page should mention
that visits are kept as individual, anonymous journeys for 90 days — the
website has no privacy page yet (checked in phase 1), so that line lands with
whichever change adds one.

## Critical files

- `plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/`
  `core/internal/{endpoints,query,collect-body,recorded-fields}.ts`,
  `server/internal/{tables,collect,routes,aggregate-sql}.ts`, new
  `server/internal/sessions.ts`, `web/internal/{tracker,instance}.ts`
- new `plugins/apps/plugins/deploy/plugins/analytics/plugins/sessions/`
  (`core`, `server`, `web`)
- `plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard/web/internal/use-analytics-available.ts` (shared gate)
- `config/apps/deploy/deployments/site-tabs.jsonc`

## Verification

- `./equin test plugins/apps/plugins/deploy/plugins/analytics`:
  - `analytics.db.test.ts` — sessions query: order, keyset paging, every shape
    filter, a hit-dimension filter, the 200-hit cap, the raw-window refusal;
    phase 2/3: gaps and load stored, null for an old engagement body.
  - `tracker.test.ts` — hidden and idle stretches (fake clock, injected input /
    deadline / media), the cap and merge, load sent once and only with the
    first engagement.
  - `collect-body.test.ts` — new fields, strictness, size under 4 KiB at the cap.
  - `axis.test.ts` — log mapping, ticks, bar vs page split.
- `./equin check`, `./equin build`.
- End to end: browse the local `/website` (it mounts the tracker), then hit the
  worktree's own `/api/host-only/analytics/sessions` through the gateway
  (`http://<ns>.localhost:9000`, one hop) to see the visit come back; the tab
  itself needs a deployment, so check it against a real one after deploy
  (Deploy → site → Sessions), and screenshot it beside the prototype
  (`compare-diff.ts --name proto-1794248902-aof7vs`).

## Follow-ups (not in this plan)

- Exact "read %": record a page's section count with its pageview.
- Load time in the Analytics report (p75 by page / country / device).
- Load-test the deployed site (concurrent visitors; where it breaks).
