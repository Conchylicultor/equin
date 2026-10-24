# Site analytics for deployed compositions

## Context

Sites shipped by the deploy app record nothing about their visitors. The public equin website (the `website` composition on its remote server) is the first site that needs this.

Goal: a reusable analytics plugin inside the deploy app. Any composition can include it. The deployed site records visits in its own Postgres, without cookies. The local deploy app shows a dashboard on that deployment's page, matching prototype `proto-1789578017-yom7` at the **standard** tier.

Decisions already made:
- Tier: **standard**. Stored fields: timestamp, host, kind, path, referring site, referring page path, campaign tags, language, device/browser/OS families, time on page, custom events, and the daily visitor hash. `country` is kept as a column but stays empty for now. IP-to-country lookup becomes a follow-up task.
- Custom events on the equin site: the Improve popup opens, the element picker is used, and "Show me" is clicked (which plays the replay).
- Retention: per-visit rows are kept **90 days**. **Daily totals are kept forever**, and they include the counts for every single filter. So clicking one row still filters any past range, and stacking a second filter works only on the last 90 days.
- Never recorded: IP addresses, the full user-agent string, cookies or local storage, query strings, or anything that links a visitor across days. *(Superseded 2026-09-29: a returning visitor now keeps one random id while they return within 30 days — see `2026-09-29-apps-analytics-sliding-visitor-identity.md`.)*

## Facts the design rests on

- **Every route of a deployed site is public.** Caddy proxies the whole hostname to the install's gateway on `127.0.0.1:<loopbackPort>` (`caddySite()` in `plugins/framework/plugins/cli/plugins/deploy/cli/internal/converge-script.ts`). `defineEndpoint` has no auth concept, and excluding `auth` only removes OAuth code from the build. So the stats read endpoint needs its own protection.
- **The local app already reaches the box over SSH.** `sshRun` (`plugins/infra/plugins/ssh`) joins argv with spaces for the remote shell. `activate-script.ts` already curls the install's loopback URL from inside the box.
- **How the visitor's IP reaches the backend.** Public traffic goes Caddy → Go gateway (`httputil.ReverseProxy` in Director mode, which *appends* to `X-Forwarded-For`, `gateway/worktree.go` `newReverseProxy`) → backend. Caddy replaces any client-supplied `X-Forwarded-For` with the real client IP. So a public request arrives with `X-Forwarded-For: <client>, 127.0.0.1`. A curl run on the box arrives with `127.0.0.1` alone.
- **Deployment page slot.** `DeploymentDetail.Section` (`plugins/apps/plugins/deploy/plugins/deployments/web/slots.ts`); the pane itself is only `<DeploymentDetail.Host>`.
- **Navigation signal.** `usePathname()` (`plugins/primitives/plugins/pane/web/pane.ts`) re-renders on `shell:navigate` and `popstate`.
- **Existing building blocks.** Recharts plus the `plugins/stats/plugins/commits/web/components/chart-primitives.tsx` helpers and the `chart-1..5` tokens for charts. `defineRetention` (`plugins/infra/plugins/retention`) for sweeps. `defineJob` with `schedule` for the nightly rollup. `fetchEndpoint(..., { keepalive: true })` for beacons (no `sendBeacon`/text-plain route).
- The Improve hooks live in `plugins/apps/plugins/website/plugins/improve/web/components/`: `improve-nav-item.tsx` (`onOpenChange`), `improve-panel.tsx` (`onPick`, `showMe`).

## Plugin layout

Umbrella `plugins/apps/plugins/deploy/plugins/analytics/` with three sub-plugins. The split keeps the deployed site's closure free of the deploy UI and of SSH.

```
analytics/
  plugins/
    host-only/   leaf: "reachable only from the box itself" routes
    collect/     ships INSIDE the deployed site: tracker, ingest, tables, rollup, retention, host-only query
    dashboard/   ships in the LOCAL app: DeploymentDetail section + SSH-backed query endpoint
```

### `host-only` (core + server, a tiny leaf)
- core: `HOST_ONLY_PREFIX = "/api/host-only/"`.
- server: `hostOnly(handler)` wraps a route. It rejects with 404 unless `X-Forwarded-For` has exactly one hop (the gateway's own append). This is a second guard behind Caddy.
- `caddySite()` imports the prefix and emits `respond /api/host-only/* 404` ahead of `reverse_proxy`. The block comes from the generated config, so no deployment can forget it. The next `deploy converge` applies it to the equin server.
- server also exports `requestClientIp(req)`: the second-to-last `X-Forwarded-For` entry, the one Caddy wrote. The knowledge of the proxy chain lives in this one function.

### `collect`

**core**
- `CollectBody` (zod): `{ kind: "pageview", path, referrer?, utm? , language }` / `{ kind: "event", name, props? , path }` / `{ kind: "engagement", pageviewId, engagedMs }`. Paths are stripped of the query string on the client, and again by the server.
- `AnalyticsQuery` / `AnalyticsReport` (zod): range (`today | 7d | 30d | 12m`), `compare` flag, and filters (dimension/value pairs). The report holds the summary with its previous period, the time series, and top-N rows per panel dimension. It also says which source answered: `raw` (any number of filters) or `totals` (at most one filter).
- `RECORDED_FIELDS`: the field list shown in "What one visit records", plus `NEVER_RECORDED`. The panel renders this data, and the server's insert is typed against the same list, so the panel cannot drift from what is actually stored.
- `channelOf(referrerHost, utm)`: a closed list mapping to Direct / Search / Social / Referral / Campaign.
- Dimensions are a closed union: `page | entry_page | exit_page | channel | referrer_host | referrer_path | utm_campaign | country | language | device | browser | os | event`.

**web**
- `<AnalyticsTracker />`: the consuming app mounts it once. It is not a `Core.Root` contribution, because the local all-plugins composition would then track itself. It reads `usePathname()` and posts one pageview per path change, taking `document.referrer` and `utm_*` on the first pageview only. On `visibilitychange→hidden` / `pagehide` it sends `engagement` with the visible milliseconds for the current pageview. It stores nothing in cookies or storage.
- `track(name, props?)`: posts a custom event for the current path.

**server**
- Tables (`server/internal/tables.ts`):
  - `analytics_salts(day date pk, salt bytea)`: one random salt per UTC day. Days before today are deleted by the rollup job, so yesterday's hashes can no longer be reproduced.
  - `analytics_visits(id uuid pk, visitor_hash, day, started_at, last_at, entry_path, exit_path, pageviews, engaged_ms, referrer_host, referrer_path, channel, utm_source/medium/campaign, country null, language, device, browser, os)`
  - `analytics_hits(id uuid pk, visit_id fk cascade, ts, kind, path, event_name null, event_props jsonb null, engaged_ms)`
  - `analytics_daily(day, filter_dim, filter_value, dimension, value, visitors, visits, pageviews, bounces, duration_ms, events; pk(day, filter_dim, filter_value, dimension, value))`.
    - `filter_dim = "none"` rows are the unfiltered totals. A (filter_dim, filter_value) pair holds the same breakdown restricted to visits matching that one filter, for example every page count among visits whose channel is Search.
    - `dimension = "total"` is the summary line, which also feeds the chart.
    - Size: rows per day ≈ (distinct values seen that day)² at most. A low-traffic site sees a few dozen values a day, so a few thousand small rows a day, about a million a year. If that grows, cap stored pairs to the top-N values per dimension per day and put the rest in an `(other)` bucket.
- `POST /api/analytics/collect` (public, `implement()`):
  - `visitor_hash = sha256(salt_today ‖ ip ‖ userAgent ‖ host)`. The IP and user agent are used only in memory.
  - UA → device/browser/OS families with a small hand-rolled parser (closed family lists, no dependency). `Accept-Language` gives the primary tag.
  - Visit: the latest visit with the same hash whose `last_at` is under 30 minutes old, otherwise a new one. Visit-level attributes (source, device, entry page) are set when it is created. `exit_path`, `pageviews`, `last_at` and `engaged_ms` are updated on each hit.
  - The pageview response returns `pageviewId`, which the engagement beacon references.
  - Guards: body size cap, event name `^[a-z0-9_]{1,64}$`, at most 10 props of short strings, and the path length is capped.
- `GET /api/host-only/analytics/query?q=<base64url JSON>` wrapped in `hostOnly`. base64url is safe to pass through `sshRun`'s space-joined remote shell with no quoting.
  - Ranges that fit inside 90 days query `analytics_visits`/`analytics_hits` directly, so filters apply to every panel. Bounce = visits with 1 pageview. Duration = `last_at - started_at` plus the last page's engaged time.
  - Ranges reaching past 90 days (12 months) read `analytics_daily` at the (none) or single-filter level for completed days, plus a raw query for today. The report is marked `totals`. A second filter is refused with a typed error. Unique visitors are exact under summing, because the hash already resets daily.
- `analytics.rollup` job (`defineJob`, `schedule: { cron: "15 0 * * *" }`): recomputes `analytics_daily` for yesterday, all levels (none and every single filter). It runs one grouped SQL per level over that day's visits and replaces the day's rows in a transaction, so it is safe to rerun, then deletes old salts. It also backfills any day with visits but no `total` row, so a missed night heals itself.
- `defineRetention` on `analytics_visits` (`ttlDays: 90`, hits cascade). Its `beforeDelete` asserts the deleted days have `total` rows and throws otherwise, so raw rows are never removed before they are summed.

### `dashboard`

**server**
- `POST /api/deploy/analytics/query { deploymentId, query }`. It resolves the deployment to its server and SSH target, reusing the same target resolution as the health check (`plugins/apps/plugins/deploy/plugins/health/server/internal/handle-check.ts`; extract a shared helper if it is inlined there). It then runs `sshRun(target, ["curl","-fsS","-m","10", "http://127.0.0.1:<port>/api/host-only/analytics/query?q=<b64>"])` and parses stdout with `AnalyticsReport`. SSH failures come back as the discriminated `sshRun` failure, rendered as an error state, never as an empty dashboard.

**web**
- A `DeploymentDetail.Section` titled "Analytics", shown only when the deployment's composition closure contains `collect`. The composition plugin already exposes membership, so the section never names `website`.
- It follows the prototype: range control, compare toggle, KPI tiles that choose the chart (Recharts line with a dashed previous-period line), and panels for Pages (Top/Entry/Exit), Sources (Channels/Referrers/Campaigns/Linking pages), Locations (Languages; Countries shows "not collected yet"), Devices (Device/Browser/OS), Events (count and share of visits that converted), and "What one visit records" rendered from `RECORDED_FIELDS`.
- Clicking a row adds a filter chip and refetches, so clicking a source updates Pages to the pages its visitors landed on. On a `totals` report, one chip works. Adding a second is disabled, with a one-line note that stacked filters cover the last 90 days only.
- Panels are small ranked lists (transient chrome over a fetched report, not live-state records). Data comes from `useEndpoint` keyed by the query, with a `primitives/loading` state and a manual refresh button. No polling.

## Equin website wiring

- Mount `<AnalyticsTracker />` once in the website app's persistent shell (`plugins/apps/plugins/website/plugins/shell/web/`). Confirm the host there does not remount on pane change; the tracker also dedups on path.
- `improve-nav-item.tsx`: `track("improve_open")` when `onOpenChange(true)`.
- `improve-panel.tsx`: `track("improve_element_picked")` in `onPick`, and `track("improve_show_me")` in `showMe()`.
- The imports pull `collect` into the website's closure. Run the `composition-closure` check, which must still show no `auth` / `agent-runtime` (collect depends only on database, jobs, retention, endpoints and pane).

## Follow-up tasks (file via `add_task` at implementation)
- IP-to-country lookup on the server (a local database, looked up in memory and then dropped).
- Extended tier (scroll depth, screen bucket, web vitals, funnel) if wanted later.

## Critical files
- New: `plugins/apps/plugins/deploy/plugins/analytics/**`
- `plugins/framework/plugins/cli/plugins/deploy/cli/internal/converge-script.ts` (`caddySite`: host-only block)
- `plugins/apps/plugins/website/plugins/improve/web/components/{improve-nav-item,improve-panel}.tsx`
- `plugins/apps/plugins/website/plugins/shell/web/…` (tracker mount)
- Possibly `plugins/apps/plugins/deploy/plugins/health/server/internal/handle-check.ts` (extract SSH target helper)

## Verification
1. `./equin test plugins/apps/plugins/deploy/plugins/analytics`: unit tests for the UA family parser, `channelOf`, the visit grouping (30-minute gap), the XFF parsing / `hostOnly` rules, and a `db-test-fixture` test for collect → rollup → retention (the `beforeDelete` guard throws when a day was not rolled up), and a parity test: for a seeded day, every single-filter report from `analytics_daily` equals the same report computed from raw rows.
2. `./equin build`, then browse the website app on this worktree (`screenshot.ts --path /website ...`) and open Improve. Visits recorded locally land in this worktree's DB, which is harmless because the dashboard reads the remote box. Check the rows with `query_db`, and call the host-only query endpoint on the worktree socket.
3. `caddySite` snapshot test shows the `respond /api/host-only/* 404` block.
4. Real deploy (only with the user's go-ahead): `deploy converge` + `ship` the website. Then `curl https://<host>/api/host-only/analytics/query` → 404. Visit the site, open Improve, pick an element, click Show me. Open the deployment page in the local deploy app, where the Analytics section shows the visit, pages, source and the three events. Click a source and Pages narrows.
5. `./equin check` (boundaries, composition-closure, migrations-in-sync, endpoints checks).
