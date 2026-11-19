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
| `update-e2e` | the change, on the **database's** clock (an external value: its notify's `changedAt` — a file's write — else the notify) | the value is applied in the tab | browser |
| `deliver-server` | the server notices the change | it sends the frame | server |
| `watch-delivery` | a write to a watched file (its ctime), or the watch's arming when the write predates it | the watch hears it (before any debounce); ≤ 1 sample / watcher instance / 5 s | server (`infra/file-watcher`'s `onWatchDelivery`) |
| `turn-echo` | the agent took a sent message (`submittedAt`) | its transcript line is on screen in the tab | browser (`turn-echo` signal) |
| `input` | a person's click, tap or keypress (`pointerdown` / `keydown`, trusted) | the next painted frame — Event Timing's `duration` (input delay + handlers + rendering, what INP is made of) | browser (`web/internal/input-tracker.ts`) |
| `thread-lag` | — | worst event-loop lag of each 10 s health sample | server |

`input` counts EVERY interaction, not only the slow ones `reports/main-thread-stall`
files. Event Timing reports an interaction only from 16 ms up, so each trusted
`pointerdown` / `keydown` is counted at dispatch and one no entry claims within a
second is recorded at 16 ms — "16 ms or less", an upper bound, so the fast majority
is never missing from the percentiles. A pointer that became a scroll or a drag
(entries with `interactionId` 0) is not an interaction and is not recorded; one
under 16 ms leaves no entry and is counted as fast — a small bias toward fast.

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

An interaction is filed under its **route pattern** (pane `peekRoutePattern`:
`/deploy/site/:deploymentId/:tab?`), never the address bar — whose ids, keyed
params and DataView filters can be any length. The exact page rides beside it
as `placeKey` (a hash of the path) for the loop judge (`plugins/client-rate`);
older rows hold the raw path in `route`. A batch the server refuses (4xx) is
dropped and thrown (a crash report), never re-queued: it would be refused forever.

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

**Whose tab: `latency_ledger_client_minute`.** A browser batch is ALSO filed under
its tab's kind — `real` (a person's tab) or `automated` (the agent browser, an e2e
run: `navigator.webdriver`) — in a table of its own, written in the same statement
as the combined row (`mergeClientMinute`), so what the user feels can be read apart
from an agent's reload loop. The combined table is untouched: it stays every tab's,
and "every tab" reads continuously across the split (2026-11-19). A tab that
cannot hold a tab id (`NO_TAB_ID`) still sends its kind (with a null `tabId`), so
its minutes are split too; only a batch from a bundle that sends no client at all
lands in the combined row only — never guessed. (Not a `client_kind` column
on the combined table: changing a hot table's primary key leaves it with no unique
constraint between the expand and the deferred contract, and every upsert of the
old and the new code fails in that window.) The day rollup reads the combined rows
as `all` (browser metrics) or `server`, and the split as `real` / `automated`
(`LATENCY_CLIENT_KINDS`).

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

**Days are added up once.** `latency_ledger_day` holds each closed UTC day (every
boundary a UTC instant passed as a parameter — the session runs in the machine's
zone, Europe/Paris on main) per
(metric, client kind, minute class), and `latency_ledger_host_day` the day's
minutes by class — written together in one statement by the hourly
`latency-ledger.roll-days` job (`server/internal/daily.ts`) once no browser batch
can still reach the day (ingest accepts minutes up to 6 h old; a day is rolled 7 h
after it ends). The host-day row is the "rolled" mark; a missed hour is caught up
by the next, and the first run after a deploy backfills the 34 days the minute
table still holds. `loadDailyLatency(sinceDay)` (server barrel) reads the rolled
days and sums the rest (today, and yesterday until it is rolled) live: summing
35 days of minutes took 3.5 s on main (2026-11-19, ~116k rows × 67 buckets); the
rollups are kept 400 days. Each day row carries its histogram, so a reader merges
days into any period (a week's p95 is the merged histogram's, never an average of
daily p95s).

All the tables are excluded from the change feed, from forks (a worktree showing
main's numbers as its own would be wrong) and from backups.

## The read path

The Stats card reads `latency-ledger.summary`, a live value with a typed `window`
param (`1h` / `24h` / `7d`) and a `tabs` param (`LATENCY_SUMMARY_TABS`): `real`
(the card's default — what the user feels), `automated`, or `all`. For one kind
of tab the browser metrics — and the exit criteria over them — read
`latency_ledger_client_minute`, while the server's own metrics (delivery, thread
lag) still read the combined table; the slowest list keeps the rows of that kind
(a row with no client only under `all`). `all` reads the combined table alone,
as before the split. Its tables are feed-blind by declaration, so it is
served external (`server/internal/summary-resource.ts`) and the minute flush is
its change source: `noteFlushedMinute` keeps a monotonic guard and notifies only
the windows a tab is subscribed to (tracked with `whileSubscribed`; the rules
live in the pure `server/internal/flush-notifier.ts`, unit-tested). The value
declares the five tables it reads as `reads.outsideFeed` (accepted by the
read-set drift guard, never routed; change-feed refuses one it does cover).

It is `load: "on-demand"`: the 7-day histogram sum alone (one of the loader's
queries, a lower bound on the load) measured ~340 ms on main
(2026-10-02; ~28k minute rows × 67 buckets; 24 h ~140 ms), past the 50 ms bar for
a value recomputed in the shared flush. A flush sends an `invalidate` and each open
card refetches over HTTP. Switching windows is a new tuple, so it shows a loading
state rather than the previous window's numbers.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The browser half of the latency ledger: times every page load and in-app navigation until every list on screen has its data, and the delay of every update pushed into the tab, and posts them as per-minute histograms at most once a minute. The server half of the latency ledger: counts every delivery to a tab, every 10 s thread-lag sample and every stack sample by owning plugin into per-minute histograms, merges the browser's page-load / navigation / update-delay minutes into the same rows, and answers p50 / p95 for any window split into calm and under-pressure minutes, with the track's exit criteria as pass / fail.
- Web:
  - Contributes: `Core.Root` → `LatencyCollector`
  - Uses:
    - `infra/endpoints.EndpointAgentWriteRefusedError`
    - `infra/endpoints.EndpointError`
    - `infra/endpoints.fetchEndpointOver`
    - `network/live/live-state.pendingMountSnapshot`
    - `network/live/live-state.subscribePendingMounts`
    - `primitives/log-channels.clientLog`
    - `primitives/networking/page-transport.pageTransport`
    - `primitives/pane.currentRoutePath`
    - `primitives/pane.peekRoutePattern`
    - `primitives/perfs/page-pauses.pausesDuring`
    - `primitives/scope/automation.AUTOMATED_BROWSER`
    - `primitives/scope/tab-id.getTabId`
    - `primitives/scope/tab-id.NO_TAB_ID`
- Server:
  - Contributes: 22 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `backup-data-exclusion` ×7
    - `change-feed-exclusion` ×7
    - `fork-data-exclusion` ×7
    - `resource.declare` "latency-ledger.summary"
  - Uses:
    - `database.db`
    - `database.writeAtomically`
    - `database/admin.ExcludeFromBackup`
    - `database/admin.ExcludeFromFork`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `debug/health-monitor.onHealthSample`
    - `debug/health-monitor.onHostSample`
    - `debug/health-monitor.onStackSamples`
    - `infra/endpoints.implement`
    - `infra/file-watcher.onWatchDelivery`
    - `infra/host/duress/latch.isUnderDuress`
    - `infra/host/duress/shed.createShedBuffer`
    - `infra/jobs.defineJob`
    - `infra/retention.defineRetention`
    - `network/live.serveValue`
    - `network/live/change-feed.ExcludeFromChangeFeed`
  - DB schema: `plugins/debug/plugins/latency-ledger/server/internal/tables.ts`
  - Exports (types): `ClientHour`
  - Exports (values):
    - `loadDailyLatency`
    - `readClientHours`
    - `readClientRoutes`
  - Register:
    - `defineJob('retention.latency_ledger_minute')`
    - `defineJob('retention.latency_ledger_client_minute')`
    - `defineJob('retention.latency_ledger_host_minute')`
    - `defineJob('retention.latency_ledger_thread_minute')`
    - `defineJob('retention.latency_ledger_interaction')`
    - `defineJob('retention.latency_ledger_day')`
    - `defineJob('retention.latency_ledger_host_day')`
    - `defineJob('latency-ledger.roll-days')`
  - Resources: `latency-ledger.summary` (invalidate, notified, whole: the plugins whose code ran on the serving thread — each minute keeps only its top owners (the rest as `other`), so a window holds a few dozen, capped: LATENCY_METRICS.length, capped: EXIT_CRITERIA.length, capped: SLOWEST_INTERACTIONS)
  - Routes: `POST /api/latency-ledger/client`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.cappedList`
    - `packages/list-bound.wholeList`
  - Exports (types):
    - `ClientLatencyMetric`
    - `ClientMinute`
    - `DailyLatency`
    - `ExitCriterion`
    - `HistogramAcc`
    - `Interaction`
    - `LatencyClientKind`
    - `LatencyMetric`
    - `LatencyStat`
    - `LatencySummary`
    - `LatencySummaryTabs`
    - `LatencyWindow`
    - `LedgerClient`
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
    - `LATENCY_CLIENT_KINDS`
    - `LATENCY_METRICS`
    - `LATENCY_SUMMARY_TABS`
    - `LATENCY_TABS_SPLIT_SINCE`
    - `LATENCY_WINDOWS`
    - `latencySummary`
    - `LedgerClientSchema`
    - `mergeAcc`
    - `mergeCounts`
    - `METRIC_LABELS`
    - `minuteStartOf`
    - `percentileFromCounts`
    - `PRESSURE_DECOMPRESSIONS_PER_SEC`
    - `PRESSURE_FREE_MEM_MB`
    - `SLOWEST_INTERACTIONS`
    - `submitClientLatency`
    - `THREAD_STALL_MS`
- Cross-plugin:
  - Imported by:
    - `debug/latency-ledger/client-rate`
    - `stats/responsiveness`
    - `stats/scoreboard`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `networking/no-page-transport` — `web/internal/client-ledger.ts` (sanctioned)
    - `sql-writes:fit:hand-written` — `server/internal/daily.ts` (sanctioned)
- Sub-plugins:
  - **`client-rate`** — Client-rate report renderer: a one-line Debug → Reports summary (how many page loads one tab made this hour, against the usual client-hour, marked when automated), plus the config registration.…

<!-- AUTOGENERATED:END -->
