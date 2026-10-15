# latency-ledger

How fast does the app feel — p50 and p95, for any window, calm minutes apart from
minutes under memory pressure? Before this plugin only page loads and updates that
crossed an alert threshold were kept (`debug/slow-ops`, `debug/trace`), so the
question had no answer and the responsiveness track's exit criteria could not be
checked.

The measurements already existed and were thrown away below a threshold. The
ledger keeps **all** of them, as per-minute histograms.

## What is measured

| metric | starts | ends | measured in |
|---|---|---|---|
| `page-load` | browser navigation start | every list mounted during the load has its data, plus one painted frame | browser |
| `navigate` | an in-app navigation (`shell:navigate`, `popstate`) | same | browser |
| `update-e2e` | the change, on the **database's** clock | the value is applied in the tab | browser |
| `deliver-server` | the server notices the change | it sends the frame | server |
| `thread-lag` | — | worst event-loop lag of each 10 s health sample | server |

`update-e2e` exists because `deliver-server` is blind to the thing this track is
about: its clock starts when the serving thread finally reads the NOTIFY, so a
stalled thread hides its own delay. `update-e2e` starts at `clock_timestamp()` in
the change-feed trigger (or at the `notify()` call for a resource whose truth is
outside Postgres), rides every pushed value frame in its `timing`, and is compared
to the tab's `Date.now()` once the frame is applied. Two wall clocks — sound only
because browser, backend and Postgres share one machine (one instance per user).

The browser half reads it as the `update` signal's `totalMs` on
`clientLatencySink` (`primitives/perfs/latency-signal`), one subscriber among
several (Debug → Slow Events files the slow ones, split into phases). A delta
that forced a resubscribe instead of applying emits no sample, so it is not
counted here either.

"Has its data" is a page-wide count kept by live-state
(`pending-mount-tracker.ts`): mounted `useResource` reads still waiting for their
first value. An interaction ends when the count is zero and stays zero for a short
quiet window (the next screen's components mount a little after the click). The
duration recorded is up to the last list's data, not to the end of the quiet window.

## Honesty rules

- **A hidden tab's sample is kept out of the distribution** (counted as
  `excluded`). Its timers are throttled; a hidden tab once recorded a 26-minute
  "page load".
- **A minute in which the machine slept is left out entirely.** Sleep is measured
  exactly by `packages/sleep-clock` and stamped on the health sample (`sleptMs`);
  the summary classes that minute `slept`. Laptop naps of 5–17 s used to be filed
  as server stalls.
- **A load still waiting after 60 s, or cut short by the next navigation, is
  recorded as "at least this long"** (`censored`), never dropped: a user who leaves
  a slow screen because it is slow must not erase that screen's sample.
- **No record is not calm.** Samples the browser sent for a minute the server has
  no host row for show under `unknown`.

## Storage

One row per `(metric, minute)` holding a fixed log-scale histogram
(`core/internal/histogram.ts`: growth 1.2, 67 buckets, 1 ms to ~140 s). The
browser's minutes and the server's merge into the same row by adding the arrays
element-wise in one upsert — no read-modify-write, any number of tabs, either
order. Rows per day do not grow with traffic; retention is 35 days.

**Never change the bucket scheme in place.** Every stored array is aligned to it.
A new scheme gets a new `HISTOGRAM_SCHEME`; the upsert refuses to add across
schemes and the query ignores the old rows.

`latency_ledger_host_minute` stores the machine's raw readings per minute, not a
verdict. Whether a minute is "under pressure" is decided when reading, in ONE place
— `minuteClass` in `server/internal/query.ts` — so the bar can be re-cut without
rewriting history. It runs in SQL so a 7-day window's histograms are summed in
Postgres, off the serving thread.

`latency_ledger_thread_minute` answers "what runs on the serving thread, at what
cost": the health monitor's always-on stack sampler was drained every 10 s and its
samples thrown away unless a stall happened; now every batch is counted by the
plugin whose code was running (`thread-owners.ts`). The sampler only samples a busy
thread, so samples × period is time ON the thread. It names the owner of the
running code, not what started it — an async continuation has lost its caller.

## The write path

The server recorder (`recorder.ts`) has no timer and is not a job. It listens to
three things that already happen — every delivery (`onResourceDelivery`), every
health sample (`onHealthSample`), every drained stack batch (`onStackSamples`) —
and writes a minute when the next one begins. Not a job on purpose: the counters
live in the serving process, and the planned serving/background split moves the job
runner to another process. Writes go through `createShedBuffer`: under duress the
first minutes of each kind are written at once and the rest after the episode, under
their own minute. The pressure minutes are the ones this exists to see.

The browser posts at most once a minute per tab and on `pagehide`. A batch is
cleared when handed to the network and put back if the request fails, because the
server adds what it receives.

All four tables are excluded from the change feed, from forks (a worktree showing
main's numbers as its own would be wrong) and from backups.

## The read path

The Stats card reads `latency-ledger.summary`, a live value with a typed `window`
param (`1h` / `24h` / `7d`). Its tables are feed-blind by declaration, so it is
served external (`server/internal/summary-resource.ts`) and the minute flush is
its change source: `noteFlushedMinute` keeps a monotonic guard and notifies only
the windows a tab is subscribed to (tracked with `whileSubscribed`; the rules
live in the pure `server/internal/flush-notifier.ts`, unit-tested). The
no-db-backed-notify check allows a DB-reading external value here only over a
table this plugin names in its own `ExcludeFromChangeFeed({ table: … })` calls —
derived, not allowlisted.

It is `load: "on-demand"`: the 7-day histogram sum alone (one of the loader's
queries, a lower bound on the load) measured ~340 ms on main
(2026-10-02; ~28k minute rows × 67 buckets; 24 h ~140 ms), past the 50 ms bar for
a value recomputed in the shared flush. A flush sends an `invalidate` and each open
card refetches over HTTP. Switching windows is a new tuple, so it shows a loading
state rather than the previous window's numbers.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The browser half of the latency ledger: times every page load and in-app navigation until every list on screen has its data, and the delay of every update pushed into the tab, and posts them as per-minute histograms at most once a minute. The server half of the latency ledger: counts every delivery to a tab, every 10 s thread-lag sample and every stack sample by owning plugin into per-minute histograms, merges the browser's page-load / navigation / update-delay minutes into the same rows, and answers p50 / p95 for any window split into calm and under-pressure minutes, with the track's exit criteria as pass / fail.
- Web:
  - Contributes: `Core.Root` → `LatencyCollector`
  - Uses:
    - `infra/endpoints.EndpointError`
    - `infra/endpoints.fetchEndpoint`
    - `primitives/live-state.pendingMountSnapshot`
    - `primitives/live-state.subscribePendingMounts`
    - `primitives/log-channels.clientLog`
    - `primitives/pane.currentRoutePath`
- Server:
  - Contributes:
    - `resource.declare` "latency-ledger.summary"
    - `change-feed-exclusion` "latency_ledger_host_minute"
    - `change-feed-exclusion` "latency_ledger_interaction"
    - `change-feed-exclusion` "latency_ledger_minute"
    - `change-feed-exclusion` "latency_ledger_thread_minute"
    - `fork-data-exclusion` "latency_ledger_host_minute"
    - `fork-data-exclusion` "latency_ledger_interaction"
    - `fork-data-exclusion` "latency_ledger_minute"
    - `fork-data-exclusion` "latency_ledger_thread_minute"
    - `backup-data-exclusion` "latency_ledger_host_minute"
    - `backup-data-exclusion` "latency_ledger_interaction"
    - `backup-data-exclusion` "latency_ledger_minute"
    - `backup-data-exclusion` "latency_ledger_thread_minute"
  - Uses:
    - `database.db`
    - `database/admin.ExcludeFromBackup`
    - `database/admin.ExcludeFromFork`
    - `database/change-feed.ExcludeFromChangeFeed`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `debug/health-monitor.onHealthSample`
    - `debug/health-monitor.onHostSample`
    - `debug/health-monitor.onStackSamples`
    - `infra/endpoints.implement`
    - `infra/host/duress.createShedBuffer`
    - `infra/host/duress/latch.isUnderDuress`
    - `infra/retention.defineRetention`
    - `network/live.serveValue`
  - DB schema: `plugins/debug/plugins/latency-ledger/server/internal/tables.ts`
  - Register:
    - `defineJob('retention.latency_ledger_minute')`
    - `defineJob('retention.latency_ledger_host_minute')`
    - `defineJob('retention.latency_ledger_thread_minute')`
    - `defineJob('retention.latency_ledger_interaction')`
  - Resources: `latency-ledger.summary` (invalidate, notified)
  - Routes: `POST /api/latency-ledger/client`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `ClientLatencyMetric`
    - `ClientMinute`
    - `ExitCriterion`
    - `HistogramAcc`
    - `Interaction`
    - `LatencyMetric`
    - `LatencyStat`
    - `LatencySummary`
    - `LatencyWindow`
  - Exports (values):
    - `addSample`
    - `BUCKET_COUNT`
    - `bucketIndexFor`
    - `bucketLowerMs`
    - `CLIENT_METRICS`
    - `ClientMinuteSchema`
    - `countAtOrAbove`
    - `emptyAcc`
    - `emptyCounts`
    - `EXIT_CRITERIA`
    - `HISTOGRAM_SCHEME`
    - `InteractionSchema`
    - `isEmptyAcc`
    - `LATENCY_METRICS`
    - `LATENCY_WINDOWS`
    - `latencySummary`
    - `mergeAcc`
    - `mergeCounts`
    - `METRIC_LABELS`
    - `minuteStartOf`
    - `percentileFromCounts`
    - `PRESSURE_DECOMPRESSIONS_PER_SEC`
    - `PRESSURE_FREE_MEM_MB`
    - `submitClientLatency`
    - `THREAD_STALL_MS`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables.ts` (debt)

<!-- AUTOGENERATED:END -->
