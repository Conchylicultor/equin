# collect

Visit analytics that ship **inside** a deployed site — cookieless unless the
visitor consents (see *Consent* below). The deploy app's
dashboard (a sibling plugin) runs this plugin's own report on a local copy of the
site's tables (see *The mirror* below); this plugin never knows about SSH, the
deploy UI, or any particular site.

## Data model

- `analytics_salts` — one random salt per UTC day, kept `IDENTITY_WINDOW_DAYS`
  (30). The rollup deletes older ones, so those days' visitor hashes cannot be
  recomputed.
- `analytics_visitor_links` — `(day, hash) → visitor_id`, pruned with its salt.
  The hash is `sha256(salt ‖ network ‖ ua ‖ host)`, where the network is the
  IPv4 address whole and an IPv6 address cut to its /64 (`identityNetwork`):
  phones rotate the second half of their IPv6 address every few hours, so the
  whole address made the same phone on the same wifi a new visitor each time.
  A visitor's first hit of a day hashes them under every retained salt and
  follows the newest link to their id (else mints a random UUID), then writes
  today's link. So a visitor keeps one id while they return within 30 days, and
  is forgotten after 30 days away. Design:
  `research/2026-09-29-apps-analytics-sliding-visitor-identity.md`.
- `analytics_visits` / `analytics_hits` — raw rows, kept `RAW_RETENTION_DAYS`
  (90). A visit is a run of activity from one visitor with no gap of 30
  minutes (it may cross midnight). It is attributed to the UTC day it
  **started**.
- `analytics_daily` — forever. One row per (day, filter level, dimension, value),
  where a level is unfiltered (`none`) or exactly one `(dimension, value)` filter.
  Every column is additive, so any range is a sum.
- `analytics_visit_members` — forever. Each visit's `(dimension, value)` pairs
  and its `visitor_id`, written by the rollup. Unique visitors are **not**
  additive (one visitor spans days), so `visitorCounts` counts them distinct
  over the whole period / row / bucket from these (plus raw rows for days not
  rolled up). `AdditiveMetrics` (core) leaves `visitors` out, so summing them
  across days is a type error.
- `analytics_consent_keys` — `sha256(key ‖ host) → visitor_id` for browsers
  whose visitor accepted (see *Consent*), touched once a day, deleted by the
  rollup after `CONSENT_KEY_DAYS` (395) unused.

## Consent

A site asks its visitors once (the website's prompt, `apps/website/pages/privacy`)
and answers through `setAnalyticsConsent(accepted)`; `useAnalyticsConsent()`
reads the answer live (`undecided` / `accepted` / `rejected`, or `unknown` in a
render without browser storage — the crawlable snapshot).

- The answer lives in one page-wide web-storage entry (`web/internal/consent.ts`),
  written when the visitor answers and never rewritten by a visit, so its TTL
  (13 months) is the answer's age: the prompt asks again after it.
- **Accepting** mints a random key (`crypto.randomUUID()`) the tracker sends as
  `consentKey` on every pageview and event. The box finds the visitor by it on
  any network (`resolveVisitor`): a known key is a return; a new key adopts the
  id the daily hash resolves to at that moment, so the visit in progress — and
  any visit within the identity window — stay the same visitor's. Only the
  key's hash is stored, never mirrored.
- **Rejecting** drops the key at once; the visit is identified by the daily
  hash alone, exactly as before consent existed. A hit with a key holds the
  hash's advisory lock, then the key's.

## One membership definition

`server/internal/aggregate-sql.ts` defines, once, which (dimension, value) pairs a
visit has and what it contributes to each. The nightly rollup, the raw report and
the hourly chart are all built on it. That is why a report read from the daily
totals equals the same report from raw rows — pinned by the parity test in
`analytics.db.test.ts`.

## Visit duration

`visitDurationMs` (`server/internal/aggregate-sql.ts`) is the ONE definition of
a visit's duration; `base.duration_ms` carries it to every aggregate (the
report's `durationMs` / Visit duration KPI, the rollup's stored totals) and to
the sessions list (`Session.durationMs`, which the Sessions tab draws as is —
it never re-derives a duration). It is **wall-clock**, background included, on
one scale for every page:

- every page before the exit lasts until the next pageview — `exit_at −
  started_at`;
- the exit page has no next pageview, so it lasts what its beacons measured:
  its visible time (`exit_engaged_ms`; idle time is visible, so it is in) **plus
  its `hidden` stretches** from the exit pageview's `gaps`
  (`exit_pageview_id`). Stretches under `MIN_GAP_MS` are not recorded, and a
  merge past `MAX_GAPS` may label a little visible time hidden — both small;
- an exit pageview with `gaps = NULL` (an older tracker, a visit from before
  `gaps` existed, no beacon yet) adds no background: its visible time is all
  that is known, which is exactly the definition those visits were counted
  under before.

A page row's `durationMs` is a different metric — time on page, the page's
visible time only — and is unchanged.

**Stored totals were kept, not recomputed** (2026-11-10). `gaps` landed that
day and no deployed site had shipped it, so every visit in every stored
`analytics_daily` / rollup day has `gaps = NULL` on its exit pageview — where
the old and new definitions give the same number. Any day rolled up from now on
uses this definition, and the nightly run re-rolls the last
`ROLLUP_RECOMPUTE_DAYS` anyway.

## Event props

An event's props are the `event_prop` hit dimension, valued
`<event>.<key>=<value>` (`core/internal/event-prop.ts`; keys share the event-name
alphabet so the value splits back). So one event with a prop — which card a
visitor opened — is ONE row under `event`, broken down under `event_prop`,
instead of one event name per card. Its report rows are capped per
(event, key) (`reportRowGroup`), so one busy event never crowds out another's.
The dashboard's Events panel expands an event into these rows.

## Report sources

`reportSourceFor(query, now)` (core) decides, and both sides call it:

- `raw` — every needed day is inside the 90-day window: any number of filters.
- `totals` — reaches past it (the 12-month range): stored totals for rolled-up
  days plus raw rows for the rest (today, a missed night), at most one filter. A
  second filter gets `{ kind: "refused" }`, never an approximation.

## The owner's own visits

The site's owner marks each browser they read it in by opening
`https://<site>/#equin-me` once (`#equin-not-me` unmarks; `core/internal/audience.ts`).
The tracker (`web/internal/owner-mark.ts`) keeps the mark in a page-wide
web-storage store and sends `owner: true` on every pageview and event from a
marked browser; the visit's `owner` column is set when it opens or on its first
marked hit, never unset. The deploy app's Overview carries the link and its QR
code ("Your devices"), so a phone is one scan.

Every question names an **audience** — `visitors` (default: everyone but the
owner), `you`, or `all` — applied as `audienceCondition` on the visits every
aggregate reads (`aggregate-sql.ts`), so the report and the sessions list cut
the same way. The encoders leave the default off the wire, so a site released
before audiences still answers the default question.

The **daily totals hold visitors only**: `rollupDay` sums `NOT owner` visits
into `analytics_daily`, but writes every visit's memberships with its `owner`
flag. So "rolled up" is read from the memberships (`isRolledUp`) — a day whose
only visits were the owner's has no totals and is still summed, and retention
can sweep it. A `totals` report answers `visitors` only; any other audience is
refused `audience-beyond-raw-window` (`audienceAvailable`, called on both sides).

## Sessions

Individual visits with their hits, for the deploy app's Sessions tab:
`readVisitWindow` / `readVisitsById` / `readVisitGroups` / `countVisits`
(`server/internal/sessions.ts`, server barrel). The deploy app runs them on
its local copy of a site's tables (`apps/deploy/site-mirror`, through
`withReplicaSchema`), so this SQL is the only implementation wherever the
tables are; nothing reads visits over SSH any more (the old host-only
`sessions` / `session-counts` routes are gone).

- **A filter in the filter language** (`network/live/filter`), compiled by
  `filterSql` over `VISIT_FILTER_COLUMNS` (core): the visit's own columns,
  `durationMs` (`visitDurationMs`, the report's one definition) and the
  memberships `pages` / `eventNames` (`visitMembershipValues`: the report's
  `page` / `event` pairs, a jsonb array to the filter), so the list keeps
  exactly the visits a report row counts — pinned against the report in
  `analytics.db.test.ts`. A caller passes the columns it declares
  (`filterable`), each a subset of these.
- **A page costs the page, not the range.** The window walks
  `(started_at, id)` from its cut, checks each visit's filter against its own
  row and hits (`memberships`' `one` scope), and stops at the `limit`-th
  match; duration and memberships are computed for the page's rows only. A
  rare filter walks further for its page, never the whole range unless
  almost nothing passes. A count or a grouping costs the visits it matches.
- **Order and cuts**: `started_at` in the asked direction, then the id as
  text ascending (code point) — network/live's window order; `after`
  exclusive, `until` inclusive (`VisitCut`: the start as `toISOString()`, the
  id).
- **"Live"** is measured against the `now` passed in (the copy's moment, for
  the deploy app).
- The visitor id never leaves the box: `visitor` is the first 8 hex of its
  sha256. Design: `research/2026-11-10-deploy-sessions-tab.md`,
  `research/2026-11-12-global-table-mirror.md` § Phase 2.

## Away stretches

Each pageview hit carries `gaps` (`core/internal/gaps.ts`): when the tab was
`hidden` (hide → next show) or `idle` (visible, no pointer / key / wheel /
scroll / touch input for `IDLE_AFTER_MS`, and no audible media playing — from
the last input to the next), as offsets from the pageview's start. The tracker
sends the whole list with every engagement beacon (no request of its own);
stretches under `MIN_GAP_MS` are dropped and past `MAX_GAPS` the two closest
neighbours merge, so the body stays small. Idle is one deadline timer, pushed
back only when it fires early — never a per-input timer, never a poll. The
server keeps the newest beacon's list (larger `engagedMs`, or equal and
reaching further). `NULL` = not recorded (an event, an older tracker, no
beacon yet) — never "none", which is `[]`.

## Load timing

The page load's first pageview (the hard load; later ones are in-app
navigations) carries `load` (`core/internal/load-timing.ts`) on its first
engagement beacon — sent even if nothing else changed, no request of its own.
Read from boot-trace in `web/internal/instance.ts` (every composition boots
through `web-core`):

- `ttfbMs` — document's first byte; `fcpMs` — first contentful paint.
- `readyMs` — later of FCP and the `route-content-commit` instant. Not
  `bootWindowEnd`: its first commit is the loading screen, so it repeats FCP.
- A paint after the tab was first hidden is the tab being shown: `fcpMs` /
  `readyMs` null. Read at beacon time (first hide / leave), so no subscription.
- Whole positive ms or null, never 0. The server keeps the first load per hit;
  `NULL` = not recorded.

## Page sections

Each pageview hit carries `sections` (`core/internal/page-sections.ts`): the
page's FULL section list, in page order, named as its `section_reach` hits
name them (`landing/hero`) — what the Sessions tab measures "read %" against.
Without it the box knows only the sections someone reached.

- **Who lists a section**: `observeSectionReach` (so `useSectionReach`,
  `useWebsiteSectionReach`, every `WebsiteBand`) registers it in its page's
  list (`web/internal/page-sections.ts`) as it mounts, reached or not. A part
  of a page counts toward read % exactly when it is observed.
- **Which page**: the path the address shows when the section mounts — not
  "what is mounted when the beacon goes", because the tracker hears of a route
  change in an effect that can run after the next page's sections registered.
  An unmounted section stays listed, so a path's list only grows during the
  page load. Page order = document order (`compareDocumentPosition`).
- **When it is sent**: sections register as they mount, so the list is complete
  only once the page has rendered. It rides the pageview's engagement beacons
  (the first is at the first hide or leave — long after render), never the
  pageview itself, and is re-sent whenever it grew. No request of its own.
- **Bounds**: at most `MAX_PAGE_SECTIONS` (32) distinct names of at most
  `MAX_SECTION_NAME_LENGTH` (64) chars; registering past either throws (a
  programming error), so the body stays under `MAX_COLLECT_BODY_BYTES`.
- **Server**: keeps the longest list a beacon sent (it only grows, so longest =
  newest, whatever order keepalive beacons land in). `NULL` = not recorded (an
  event, an older tracker, a page with no sections, no beacon yet).

## The mirror

The `analytics` mirror set (`server/internal/mirror.ts`, table-mirror's
`defineMirrorSet`) is what the deploy app copies from a site's box
(`apps/deploy/site-mirror`): visits, hits, daily totals and visit memberships.
The salts, the visitor links and the consent keys never leave the box (`NeverMirrored`).

The report has **one implementation**: `runAnalyticsQuery(dbx, query, now)`,
exported from the server barrel. It reads through `AnalyticsReadDb` (the `db`
or an open transaction) and names its tables unqualified, so the dashboard runs
it unchanged inside `withReplicaSchema` — the copy's schema, then
`pg_catalog`, no `public` — as of the box's clock at the last page synced.
`analyticsMirrorTables` (server) is the set's tables, for that value's declared
reads. Nothing in the report may read the clock or a table outside the set: the
copy would answer differently, or fail.

Pinned by the mirror parity test at the end of `analytics.db.test.ts`: source
and replica in one database, every range (incl. `12m` on the stored totals) ×
audience × filters × compare, over two clocks, plus the sessions window and
its counts (the visit list's window, count and groups), equal on `public` and on the copy — after the first copy and again
after new visits, a rollup and a retention sweep arrive as deltas.

## Runtime notes

- The rollup and retention crons are `perWorktree: true` **on purpose**. A
  non-perWorktree cron installs only on main, and a deployed release is never main.
- Retention's `beforeDelete` throws for any day without totals or memberships,
  so raw rows are never deleted before they are summed.
- Visits, hits, visitor links and memberships are excluded from the
  change-feed: public traffic (or the rollup) writes them, and nothing renders
  them live (the deploy app's report reads its own copy, pushed by the
  mirror's applied pages).
- `RECORDED_FIELDS` (core) is what "What one visit records" renders.
  `server/internal/recorded-columns.ts` fails to compile if the stored columns and
  that list disagree.
- **Country.** `openVisit` looks the client IP up with `lookupCountry`
  ([`apps/deploy/analytics/ip-country`](../ip-country/CLAUDE.md)), an
  in-memory binary search over a local DB-IP snapshot, and stores only the
  resulting code. The IP is used for that lookup and the daily hashes, then
  dropped; it is never stored and never sent anywhere. Only a new visit looks
  up; a hit joining a live visit keeps its country. `(none)` in the report
  counts unlisted addresses (private, reserved) **and** visits recorded before
  the machine's first snapshot download finished.
- The tracker sends `host` (the page's `location.host`) because the gateway
  rewrites the `Host` header before the backend sees it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The visit tracker a deployed site mounts, cookieless unless the visitor consents: <AnalyticsTracker app={…} /> records one pageview per path change under that app (landing referrer and utm tags on the first only) and the visible time on each; track(name, props?) records a custom event on the current page; useSectionReach(section) / observeSectionReach(el, section) record section_reach once when a section reaches the upper half of the screen, its section prop (<page>/<key>) giving a per-section reach funnel; useAnalyticsConsent() / setAnalyticsConsent(accepted) read and answer the site's consent prompt — accepting keeps a random key in the browser for 13 months, sent with every pageview and event so a return is recognised on any network. Owns the analytics tables (daily salts kept 30 days with the hash → visitor links that let a returning visitor keep one id, 90-day visits and hits, forever daily totals at every single-filter level and forever per-visit memberships for exact unique visitors over any range), the public collect endpoint, the analytics mirror set, the report (runAnalyticsQuery) and the visit-list reads (a window of individual visits with their hits, filtered in the filter language) — both run by the deploy app on its local copy of the tables — the nightly analytics.rollup job and the visits retention sweep that refuses to delete a day not yet rolled up.
- Server:
  - Contributes:
    - `table-mirror-set` "analytics"
    - `table-mirror-never` "analytics_consent_keys"
    - `table-mirror-never` "analytics_salts, analytics_visitor_links"
    - `change-feed-exclusion` "analytics_consent_keys"
    - `change-feed-exclusion` "analytics_hits"
    - `change-feed-exclusion` "analytics_visit_members"
    - `change-feed-exclusion` "analytics_visitor_links"
    - `change-feed-exclusion` "analytics_visits"
  - Uses:
    - `apps/deploy/analytics/host-only.capBodySize`
    - `apps/deploy/analytics/host-only.isBotUserAgent`
    - `apps/deploy/analytics/host-only.requestClientIp`
    - `apps/deploy/analytics/ip-country.lookupCountry`
    - `database.db`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `database/table-mirror/source.defineMirrorSet`
    - `database/table-mirror/source.MirrorSet`
    - `database/table-mirror/source.NeverMirrored`
    - `infra/endpoints.implement`
    - `infra/endpoints.rawEndpointHandler`
    - `infra/jobs.defineJob`
    - `infra/retention.defineRetention`
    - `infra/retention.markCascadeBounded`
    - `network/live/change-feed.ExcludeFromChangeFeed`
    - `network/live/filter.filterSql`
  - DB schema: `plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/server/internal/tables.ts`
  - Exports (types):
    - `AnalyticsReadDb`
    - `CollectContext`
    - `CountryLookup`
    - `VisitFilterable`
    - `VisitReads`
    - `VisitWindowQuery`
  - Exports (values):
    - `analyticsMirrorTables`
    - `countVisits`
    - `readVisitGroups`
    - `readVisitsById`
    - `readVisitWindow`
    - `recordCollect`
    - `runAnalyticsQuery`
  - Register:
    - `defineJob('analytics.rollup')`
    - `defineJob('retention.analytics_visits')`
  - Routes: `POST /api/analytics/collect`
- Web:
  - Uses:
    - `infra/endpoints.fetchEndpointOver`
    - `primitives/dom/in-view.createInViewWatcher`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/dom/web-storage.Store`
    - `primitives/networking/page-transport.pageTransport`
    - `primitives/pane.currentRoutePath`
    - `primitives/pane.usePathname`
    - `primitives/perfs/boot-trace.getBootTrace`
  - Exports (types):
    - `AnalyticsConsent`
    - `ConsentState`
  - Exports (values):
    - `AnalyticsTracker`
    - `observeSectionReach`
    - `setAnalyticsConsent`
    - `track`
    - `useAnalyticsConsent`
    - `useSectionReach`
- Core:
  - Uses:
    - `framework/plugin-id.asPluginId`
    - `infra/endpoints.defineEndpoint`
    - `packages/list-bound.cappedList`
    - `packages/list-bound.cappedRecord`
    - `packages/list-bound.wholeList`
  - Exports (types):
    - `AdditiveMetrics`
    - `AnalyticsFilter`
    - `AnalyticsQuery`
    - `AnalyticsQueryResult`
    - `AnalyticsRange`
    - `AnalyticsReport`
    - `Audience`
    - `BrowserFamily`
    - `Channel`
    - `CollectBody`
    - `CollectResponse`
    - `DailyDimension`
    - `DeviceFamily`
    - `Dimension`
    - `EngagementBody`
    - `EventBody`
    - `EventProp`
    - `FilterLevel`
    - `Gap`
    - `GapKind`
    - `Granularity`
    - `HitDimension`
    - `LoadTiming`
    - `Metrics`
    - `OsFamily`
    - `PageSections`
    - `PageviewBody`
    - `PeriodReport`
    - `RecordedColumn`
    - `RecordedField`
    - `ReportPeriod`
    - `ReportRow`
    - `ReportSource`
    - `SeriesPoint`
    - `Session`
    - `SessionHit`
    - `UtmTags`
    - `VisitCut`
    - `VisitDimension`
    - `VisitFilterColumn`
  - Exports (values):
    - `addDays`
    - `addMetrics`
    - `addMonths`
    - `ANALYTICS_MIRROR_SET_ID`
    - `ANALYTICS_RANGES`
    - `AnalyticsFilterSchema`
    - `AnalyticsQueryResultSchema`
    - `AnalyticsQuerySchema`
    - `AnalyticsRangeSchema`
    - `AnalyticsReportSchema`
    - `appendGap`
    - `AUDIENCE_LABEL`
    - `AUDIENCE_OPTIONS`
    - `audienceAvailable`
    - `AUDIENCES`
    - `AudienceSchema`
    - `averageTimeOnPageMs`
    - `averageVisitDurationMs`
    - `bounceRate`
    - `BROWSER_FAMILIES`
    - `BrowserFamilySchema`
    - `bucketOf`
    - `channelOf`
    - `CHANNELS`
    - `ChannelSchema`
    - `COLLECT_PLUGIN_ID`
    - `collectEndpoint`
    - `CollectResponseSchema`
    - `CONSENT_KEY_DAYS`
    - `ConsentKeySchema`
    - `conversionRate`
    - `DailyDimensionSchema`
    - `DAY_PATTERN`
    - `DaySchema`
    - `DEFAULT_AUDIENCE`
    - `DEVICE_FAMILIES`
    - `DeviceFamilySchema`
    - `DIMENSIONS`
    - `EngagementBodySchema`
    - `EVENT_NAME_PATTERN`
    - `EVENT_PROP_KEY_PATTERN`
    - `EventBodySchema`
    - `EventPropsSchema`
    - `FilterLevelSchema`
    - `firstRawDay`
    - `GAP_KINDS`
    - `gapsExtentMs`
    - `GapsSchema`
    - `GRANULARITIES`
    - `GranularitySchema`
    - `HIT_DIMENSIONS`
    - `IDENTITY_WINDOW_DAYS`
    - `IDLE_AFTER_MS`
    - `loadMs`
    - `LoadTimingSchema`
    - `MAX_COLLECT_BODY_BYTES`
    - `MAX_ENGAGED_MS`
    - `MAX_EVENT_PROP_VALUE_LENGTH`
    - `MAX_EVENT_PROPS`
    - `MAX_FILTERS`
    - `MAX_HOST_LENGTH`
    - `MAX_LOAD_MS`
    - `MAX_PAGE_SECTIONS`
    - `MAX_PATH_LENGTH`
    - `MAX_REFERRER_LENGTH`
    - `MAX_SECTION_NAME_LENGTH`
    - `MAX_SESSION_HITS`
    - `MAX_SESSIONS_LIMIT`
    - `MAX_TOTALS_FILTERS`
    - `MAX_UTM_LENGTH`
    - `MetricsSchema`
    - `NEVER_RECORDED`
    - `NONE_VALUE`
    - `normalizeHost`
    - `OS_FAMILIES`
    - `OsFamilySchema`
    - `OWNER_MARK_FRAGMENT`
    - `OWNER_UNMARK_FRAGMENT`
    - `ownerMarkUrl`
    - `ownerUnmarkUrl`
    - `PagePathSchema`
    - `PageSectionsSchema`
    - `PageviewBodySchema`
    - `parseEventPropValue`
    - `PeriodReportSchema`
    - `planPeriods`
    - `RAW_RETENTION_DAYS`
    - `RECORDED_COLUMNS`
    - `RECORDED_FIELDS`
    - `REPORT_ROWS_PER_DIMENSION`
    - `REPORT_SOURCES`
    - `reportRowGroup`
    - `ReportRowSchema`
    - `reportSourceFor`
    - `SECTION_REACH_EVENT`
    - `SECTION_REACH_PROP`
    - `SeriesPointSchema`
    - `SessionHitSchema`
    - `SESSIONS_PAGE`
    - `SessionSchema`
    - `SiteHostSchema`
    - `stripQuery`
    - `TOTAL_DIMENSION`
    - `UNFILTERED_LEVEL`
    - `utcDay`
    - `UtmTagsSchema`
    - `viewsPerVisit`
    - `VISIT_DIMENSIONS`
    - `VISIT_FILTER_COLUMNS`
    - `VisitCutSchema`
    - `visitorShare`
    - `ZERO_ADDITIVE_METRICS`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/analytics/dashboard`
    - `apps/deploy/analytics/sessions`
    - `apps/deploy/fixtures`
    - `apps/deploy/site-messages/intake`
    - `apps/website/improve`
    - `apps/website/landing/hero`
    - `apps/website/landing/screenshot`
    - `apps/website/pages/apps`
    - `apps/website/pages/download`
    - `apps/website/pages/foundations`
    - `apps/website/pages/privacy`
    - `apps/website/pages/vision`
    - `apps/website/shell`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `boundaries/no-platform-api` — `server/internal/collect.ts`, `server/internal/request-context.ts` (debt)
    - `networking/no-page-transport` — `web/internal/instance.ts` (sanctioned)
    - `sql-writes:fit:hand-written` — `server/internal/aggregate-sql.ts` (sanctioned)
- Test helpers:
  - Core: `@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core/testing`
    - `ZERO_METRICS`

<!-- AUTOGENERATED:END -->
