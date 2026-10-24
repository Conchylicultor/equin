# App usage stats: launches and time spent per app

## Context

Apps keep no usage history. `apps-core` knows which app is focused right now, but
records nothing about it. The user wants per-app stats (how often each app is
opened, how long is spent in it) so the Home page can offer custom views over them.

The work has two halves:

- **v1:** a generic usage data layer in `apps-core`.
- **The Home view:** a new **table view** ("Stats") on the existing app grid. The default
  **icons view stays minimal**.

Decisions taken with the user:

- **Launch** = the focused app *changes to* X. That covers the rail, the launcher, a tab switch
  and back/forward. A reload that restores the same app does not count, and neither does
  re-focusing the app that is already focused.
- **Time spent** = X is the focused app **and** the page is visible **and** the window has
  focus **and** there was keyboard or pointer input in the last **5 minutes**.
- **Home:** the stats are fields on the app grid, visible in a new table view. Icons stays as it is.

## Existing pieces reused

| Need | Reuse |
|---|---|
| Focused app id, provider-free (works from `Core.Root`) | `useFocusedAppId` — `plugins/apps-core/web/internal/focused-app-store.ts` (published by `use-tabs.tsx:812`, history restore, in-place swaps) |
| Headless always-on component | `Core.Root({ component })` — e.g. `plugins/reports/plugins/endpoint-errors/web/index.ts` |
| Beacon-style flush (keepalive, pagehide, retry on failure) | the pattern in `plugins/debug/plugins/latency-ledger/web/internal/client-ledger.ts:108-155` (`fetchEndpoint(..., { keepalive: true, report: false })`) |
| Additive `ON CONFLICT DO UPDATE` upsert, plain `pgTable`, single-column text PK | `plugins/primitives/plugins/usage-rank` (`tables.ts`, `routes.ts`, `usageKey`) |
| Live aggregate read | `liveValue` / `serveValue({ source: "db", unbounded })` — `plugins/network/plugins/live/CLAUDE.md` |
| Retention | `defineRetention` — e.g. `plugins/debug/plugins/latency-ledger/server/internal/retention.ts` |
| Contributing fields into a DataView from another plugin | `defineFieldExtensions<TRow>()` + `<DataView fieldExtensions>` — precedent `plugins/apps/plugins/events/plugins/sources/plugins/source-field` |
| Duration formatting | `formatValue("seconds", s)` from `@plugins/primitives/plugins/metrics/plugins/chart-kit/core` (gives 42s / 12m / 3.5h) |
| Relative date cell | `type: "date"` field (the table cell renders "Nd ago") |

`usage-rank` is **not** reused as the store. It keeps one frecency score per key and has no
daily buckets or durations. Its job is ranking, which is a different one.

## Design

### 1. `plugins/apps-core/plugins/app-usage` (new): the data layer

**core/**
- `AppUsageFlushBody`: a zod schema for `{ entries: { day: "YYYY-MM-DD", appId, launches, focusedMs, lastOpenedAt? }[] }`.
  It is bounded: at most N entries, and `focusedMs` is capped per entry (≤ 24h).
- `flushAppUsageEndpoint = defineEndpoint({ route: "POST /api/app-usage/flush", body })`.
- `AppUsageSummarySchema` with the matching `appUsageSummary = liveValue("app-usage.summary", { schema })`.
  Its shape is `{ apps: { appId, launches7d, focusedMs7d, launchesTotal, focusedMsTotal, lastOpenedAt | null }[] }`.
- `localDay(date)`: the user's local calendar day. The client buckets days, so "today" means the
  user's day. There is one instance per user, so this has a single meaning.

**server/**
- Table `app_usage_daily`: `usage_key text pk` (`${day}:${appId}`, the usage-rank precedent), `day date`,
  `app_id text`, `launches int`, `focused_ms bigint`, `last_opened_at timestamptz null`. It is a plain
  `pgTable`, since there is no parent row. It **stays** in the change feed, which drives live invalidation.
- `handleFlushAppUsage` runs one multi-row upsert:
  - `launches = launches + excluded.launches`
  - `focused_ms = focused_ms + excluded.focused_ms`
  - `last_opened_at = greatest(...)`
- `serveValue(appUsageSummary, { source: "db", loader, throttleMs: 2000, unbounded: { reason: "one row per app id ever used — bounded by the installed app registry (tens)" } })`.
  The loader is one `GROUP BY app_id` with `FILTER (WHERE day >= current_date - 6)` for the 7-day columns.
- `defineRetention` drops daily rows older than 2 years. "Total" therefore means *within retention*,
  and the code says so.

**web/**
- The `AppUsageRecorder` component is mounted on `Core.Root`. It is a thin React shell that feeds
  `useFocusedAppId()` into a non-React tracker module.
- `internal/usage-tracker.ts` is pure, testable state plus side effects. It uses no polling:
  - **Inputs (events only):**
    - focused-app change
    - `visibilitychange`
    - window `focus` / `blur`
    - throttled `pointerdown` / `keydown` / `wheel` / `pointermove` (records `lastInputAt`)
    - `pagehide`
  - **Active segment:** open while `appId && visible && hasFocus && now - lastInputAt < 5min`.
    - It closes on any transition out of that state.
    - The **idle deadline** is a one-shot `setTimeout(5min)` that is re-armed on input. It is not a
      polling loop. When it fires, the segment is closed at `lastInputAt` (plus a small grace), so
      idle time is never credited.
  - **Launch:** a focused-app transition `prev → X` where `X !== prev`. On boot, the previous app
    comes from `sessionStorage`, so a reload of the same tab is not a launch.
    - The Home app is recorded like any other app. The consumer filters it if it wants to.
  - **Day split:** a segment that crosses local midnight is split into per-day entries. This is a
    pure function and is unit-tested.
  - **Flush:** pending per-(day, app) deltas are posted with `fetchEndpoint(..., { keepalive: true, report: false })`.
    - Triggers: a focused-app change, `hidden`, `pagehide`, the idle deadline, and input arriving
      while the oldest pending delta is older than 60s. The last trigger is an event-driven checkpoint
      for long sessions, which keeps Home live and bounds what a crash loses.
    - A long active segment is checkpointed by closing it and reopening it at flush time.
    - On failure the batch is restored, as in latency-ledger.
- `useAppUsageSummary()` wraps `useLive(appUsageSummary)` and returns the `ResourceResult`.
  Pending is a loading state, never zeros.

Multiple windows: only the window with `document.hasFocus()` accrues time, so two visible windows
cannot double-count.

### 2. Home: field extension slot plus a table view

- **`apps/home/plugins/app-cards`** gains these changes:
  - It mints `HomeApps.Fields = defineFieldExtensions<ActiveApp>()` in a new `web/slots.ts` and
    exports it from the barrel.
  - It passes `fieldExtensions={HomeApps.Fields}` and `views={["icons", "table"]}` to the grid.
  - It adds a saved view to `config/apps/home/app-cards/home.apps.jsonc`:
    `{ id: "stats", name: "Stats", view: { type: "table", sort: time 7d desc } }`.
    `apps` (icons) stays first, so it remains the default. app-cards stays ignorant of usage.
- **`apps/home/plugins/usage-fields` (new)** contributes `HomeApps.Fields({ id: "usage", section: null, component: UsageFields })`.
  - It reads `useAppUsageSummary()` and yields these fields:
    - `launches7d` (int, "Opens · 7d")
    - `focusedMs7d` (number, "Time · 7d", cell `formatValue("seconds", ms / 1000)`)
    - `launchesTotal`
    - `focusedMsTotal`
    - `lastOpenedAt` (date, "Last opened")
  - Apps never used read 0 / "—" **once the summary is ready**. While it loads, the fields follow
    the loading contract and show no stand-in zeros.
  - Because they are DataView fields, they are sortable, filterable and groupable in every view.
    Icons can sort "most used first" without showing any numbers.

## Critical files

- New: `plugins/apps-core/plugins/app-usage/{core,server,web}/…` (`core/internal/{schema,endpoints,day}.ts`,
  `server/internal/{tables,routes,resource,retention}.ts`, `web/internal/{usage-tracker,use-app-usage-summary}.ts`,
  `web/components/app-usage-recorder.tsx`)
- New: `plugins/apps/plugins/home/plugins/usage-fields/web/{index.ts,components/usage-fields.tsx}`
- Edit: `plugins/apps/plugins/home/plugins/app-cards/web/{index.ts,slots.ts,components/app-grid.tsx}`
- Edit: `config/apps/home/app-cards/home.apps.jsonc`
- Each new plugin gets a `CLAUDE.md` with its design notes (event-driven tracker, idle rule, day split).

## Verification

1. `./equin test plugins/apps-core/plugins/app-usage` covers:
   - tracker unit tests on a fake clock and events: launch on transition only, no launch on a
     same-app reload, idle cut at `lastInputAt`, hidden/blur pause, midnight split, flush batching
     and restore on failure
   - a DB test that the upsert is additive and the summary SQL computes 7d vs total
2. Run `./equin build` in the background, then open `http://<worktree>.localhost:9000/home`.
   Switch between a few apps, wait, then switch to Home → Stats.
   - Opens and time should increase.
   - `query_db`: `select * from app_usage_daily` shows the rows.
3. Idle: stay without input for over 5 minutes, then check that time stopped accruing.
   For the test, use a short idle threshold via the tracker's injectable config, not a code edit.
4. Take a screenshot of the Stats view with
   `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path /home --click "Stats" --out /tmp/stats`,
   and confirm the icons view is unchanged.
5. Run `./equin check`, which covers boundaries, the live-state lint rules and migrations-in-sync.
