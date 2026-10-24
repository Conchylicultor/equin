# Analytics: sliding visitor identity (returning visitors counted once)

Follows `research/2026-09-16-deploy-site-analytics.md`.

## Context

Today the visitor hash is `sha256(daily_salt ‖ ip ‖ ua ‖ host)`, and the salt is deleted every night. A person who visits on 10 days is counted as 10 "unique visitors" in a 30-day range. The user wants a returning visitor to keep one identity as long as they keep coming back. For example, someone who visits daily for 100 days counts once. The identity should only expire after **30 days of inactivity**. It must stay cookieless (nothing on the device) and need no banner for now. Unique visitors must be **exact over every range, including 12 months**, using a slim membership table kept forever.

Privacy trade-off (accepted by the user; say it in "What one visit records"): for 30 days after someone's last visit, anyone with DB access plus their IP and browser can find their visitor id, and through it their raw visits. After 30 days of absence the chain is gone. The visitor id is a random UUID that carries no IP information.

## Design

### Identity: a random visitor id, relinked through daily hashes

- `IDENTITY_WINDOW_DAYS = 30` in `collect/core/internal/periods.ts`, next to `RAW_RETENTION_DAYS`.
- Salts stay one per UTC day. The rollup now deletes salts older than `today − 30` instead of `< today`.
- New `analytics_visitor_links(day, hash, visitor_id uuid)`, PK `(day, hash)`. A link means "on this day, this hash was this visitor". It is pruned with its salt.
- New `resolveVisitor(tx, ctx, host)` in `collect.ts`, called under the existing advisory lock (keyed on today's hash):
  1. Look up `link(today, h_today)` and use it if present. This is the hot path: one indexed read per hit.
  2. Otherwise compute `h_d` for every retained salt `d` in the window (at most 30 sha256 calls, in memory). Then `SELECT visitor_id FROM analytics_visitor_links WHERE (day, hash) IN (…) ORDER BY day DESC LIMIT 1`.
  3. If nothing matches, create a new `gen_random_uuid()`.
  4. Insert `link(today, h_today, visitor_id)`. Each active day writes a fresh link, so the chain slides forward indefinitely.
- The salt memo (`dailySalt`) becomes a per-day memo of the window's salts: one read per UTC day per process.
- `analytics_visits.visitor_hash` → `visitor_id uuid`, with index `(visitor_id, last_at)`. `findLiveVisitId` looks up by `visitor_id`. As a side effect, a visit that crosses midnight now continues instead of splitting in two. It is still attributed to the day it started.

### Exact visitors over any range: a forever membership table

- New `analytics_visit_members(visit_id, day, visitor_id, dim, value)`, PK `(visit_id, dim, value)`, index `(dim, value, day)`, kept forever, with no FK to visits (visits go after 90 days). It is the existing `m` relation from `aggregate-sql.ts` (the ONE membership definition), materialised with the visit's `visitor_id` and day. That's about 20 rows per visit.
- `rollupDay` writes it for the day in the same transaction as `analytics_daily`. It deletes the day's rows and re-inserts them from `visitsAndMemberships`, so it's safe to rerun. `daysMissingTotals` also catches rolled-up days that have raw visits but no members. That backfills every existing install once, and loses nothing, because the feature shipped 2026-09-16 and all its visits are still inside the 90-day raw window.
- The retention guard `assertDaysRolledUp` also requires members for the day, so raw rows are never deleted before their memberships exist.
- Excluded from the change feed, like visits and hits (`ExcludeFromChangeFeed`).

### Visitors stop being additive, enforced by types

- Split core `Metrics` into `AdditiveMetrics` (visits, pageviews, bounces, durationMs, events: the only thing `addMetrics` and `analytics_daily` handle) and `Metrics = AdditiveMetrics & { visitors }`. Summing visitors across days becomes a type error rather than a silent overcount.
- Drop `analytics_daily.visitors` (migration through `./equin build`).
- New `visitorCounts(dbx, { from, to, filters, groupBy })` in `aggregate-sql.ts`, where `groupBy` is `total | dimension | bucket(granularity)`. It counts distinct `visitor_id` over one membership source: `analytics_visit_members` for rolled-up days, `UNION ALL` the raw `m` for days not rolled up (today, a missed night). Filters join the members table on `visit_id`, one `EXISTS` per filter, the same semantics as `keptVisits`. It serves both report sources, so raw and totals agree by construction.
- `report.ts` / `periodData`: the summary, every dimension row and every series bucket (hour, day, month) get `visitors` from `visitorCounts` and the rest from the existing additive sums. `topRows` merges before it sorts and truncates, because it ranks by visitors.
- `eventConversion` / `visitorShare` (core `metrics.ts`) are unchanged. They now divide distinct counts by distinct counts.
- The 12-month limit of one filter stays as it is. The member table could lift it, but that's out of scope.

### Surfaces to update

- `collect/core/internal/recorded-fields.ts`: replace the `visitor_hash` entry with `visitor_id` ("Random id, relinked each day through a salted hash of IP + browser + site; forgotten after 30 days without a visit"). Replace the "Who someone is across days" never-recorded line with the 30-day statement.
- `server/internal/recorded-columns.ts`: must still compile against the new columns.
- `collect/CLAUDE.md` data model section, and the original research doc's "never recorded … across days" bullet (add a pointer to this doc).
- Dashboard: `kpis.ts` keeps "Unique visitors", which is now true. Update the fixtures in `dashboard/web/testing/fixtures.ts` if the `Metrics` split changes their shape.

## Critical files

- `plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/server/internal/{tables,collect,request-context,aggregate-sql,report,rollup,retention,recorded-columns}.ts`
- `.../collect/core/internal/{metrics,periods,query,recorded-fields}.ts`
- `.../dashboard/web/{internal/kpis.ts,internal/panels.ts,testing/fixtures.ts}`

## Verification

- `analytics.db.test.ts` (DB-backed, via `./equin test <collect path>`):
  - Same IP+UA on days 1..40 (salts rolled forward by `runRollup` each "night") → one `visitor_id`. A 7d/30d report shows `visitors = 1`, `visits = 40`.
  - A 31-day gap → a new `visitor_id`, and the old day's salt and links are deleted.
  - 12-month report (totals source, after the raw rows are swept past 90 days) → still `visitors = 1`, and it equals the raw-source count for a range inside the window (extend the existing parity test to cover visitors).
  - A filtered 12-month report: a visitor with a Search visit on day 1 and a Direct visit showing page X on day 2 is NOT counted under channel=Search / page X.
  - Retention refuses to sweep a day without members.
  - A visit that crosses midnight stays one visit.
- `./equin test` for the collect + dashboard plugins; `./equin build` (migration generation + checks).
- On the deployed dashboard, check that the analytics section renders for 7d / 30d / 12m, using `screenshot.ts --path <deployment page> --click Analytics`.
