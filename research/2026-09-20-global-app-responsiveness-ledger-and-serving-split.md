# App responsiveness: an honest latency ledger, and the plan to split the serving process

Track: "App performance and responsiveness" (page `block-c5d0ef0a-bd7d-4caa-930a-075a1267439c`).
This file is the session plan only. Findings and the split design go in the wiki as
sub-pages of the track (Track Instructions, `block-361815ed-5750-413a-b5ab-31c5dc855144`).

## Context

Two problems.

1. Nobody can say how fast the app feels. A page load is recorded only above 2 s, an
   update only above 2 s, so there is no p50 or p95, no calm / under-pressure split,
   and the track's exit criteria cannot be checked.
2. On main one server thread answers the browser and runs all background work. What
   runs there, and at what cost, was never listed. Some figures in the track's mental
   model date from July.

Outcome of this session: every page load and every update delay is recorded and shown
live; the thread's work is listed by measured cost; the split design is written and
ready for a decision. Building the split is the next session, because it needs four
decisions that are the user's (end of this file).

## Re-validation on fresh data (2026-09-19 21:00 to 2026-09-20 15:00 UTC, main)

What still holds:

- A page load sends about 250 subscriptions. Measured: median 234, 90th percentile 283
  (92 page loads in the client log).
- The read gate admits 6 reads at once. The heavy git read pool is 4 for the machine.
- After a restart of main, subscriptions queue at that gate. Measured today: 3.8 to
  4.3 s of waiting per subscription before any read began.
- Memory pressure squeezes the server. Resident memory: about 1,040 MB calm, 90 to
  470 MB under pressure.
- Every stall with a named culprit is background code (terminal pane listing, process
  tree capture, log append, transcript reads).

What was wrong or stale:

- The breakdown of the 250. It is not "150 config files + 90 page blocks". About 70%
  is three subscriptions per conversation row in the sidebar (progress, category,
  preprompt; about 43 rows). Config is about 22, page blocks about 18. The July move
  to bounded reads made each read cheap and multiplied their number.
- "10 database connections". The pool is 16, with 6 reserved for clicks.
- "Thread lag stays modest (0.8% calm, 5.7% pressure)". Fresh: the worst lag in a
  10-second window passes 200 ms in 2.5% of calm windows and 21% of pressure windows.
  p99 434 ms calm, 1.6 s under pressure, worst 3.3 s.
- "About 95% of the thread's work is unrelated to the click". That figure counted
  deliveries to tabs and update cycles as unrelated. Sending changes to open tabs is
  serving work. Truly background work was about half of the sample. Main's process
  uses 27% of one core on average; own time of HTTP requests is negligible.
- The top background cost is not on the track at all: a music-folder scan that walks
  every MIDI folder every 30 s for 2.7 s and finds nothing (2,878 slow runs,
  9,100 s in 3 days). A backstop timer re-doing settled work.
- The "unexplained 0.4/s file index refresh" is explained: it runs on every write to
  Claude's transcript folder by any Claude session on the machine (now 0.8/s,
  119 ms each).
- The conversations poller runs every second on every backend (about 16), each
  spawning `tmux` and `ps`.

Two measurement traps found, both of which the new ledger must avoid:

- Laptop sleep is recorded as server stalls. On 09-20 15:00 to 15:11 local the Mac
  napped in 5 to 17 s cycles. Main and an unrelated worktree backend both filed
  "event-loop stall" reports with identical durations (5,725 and 5,722 ms). The
  existing sleep detection only catches gaps over 50 s.
- A "page load" of 1,569 s was recorded. The timer ends in `requestAnimationFrame`,
  which does not fire in a hidden tab.

## Part A. Publish the re-validation (wiki)

- New sub-page of the track: "Re-validation 2026-09-20" with the section above, the
  method for each number, and the static inventory of what runs on main's thread
  (jobs and crons, file watchers, timers, warm-ups, monitors, the recompute cascade,
  the 25 push resources fed in-process), each with its measured cost where one exists.
- Track page: correct the mental model (subscription breakdown, pool size, the 95%
  claim), refresh the Benchmark "Before" lines with the fresh numbers, update Status
  and the task checklist.

## Part B. Latency ledger (build)

Principle: the measurements already exist and are thrown away below a threshold. Keep
all of them, as per-minute histograms, and decide calm / pressure at query time.

Metrics:

| metric | starts | ends | where measured |
|---|---|---|---|
| `page-load` | browser navigation start | every resource mounted during the load has data, plus one frame | browser |
| `navigate` | in-app navigation (`shell:navigate` window event) | same condition | browser |
| `update-e2e` | time of the database change (new field in the change-feed notification) or of the `notify()` call for non-database resources | value applied in the tab | browser |
| `deliver-server` | first notify seen by the server | socket send | server (existing `onDelivered`) |
| `thread-lag` | worst event-loop lag per 10 s sample | | server (health sampler) |

`update-e2e` starts on the database's clock on purpose: the existing server value
starts when the stalled thread finally reads the notification, so a stall hides itself.
Browser, server and Postgres share one machine and one clock; the assumption is written
next to the field.

Storage, in a new plugin `plugins/debug/plugins/latency-ledger` (`core` / `server` / `web`):

- `latency_ledger_minute`: one row per (metric, minute): fixed log-scale bucket counts
  (growth 1.2, 66 buckets, 1 ms to 130 s, plus overflow), count, sum, max, censored
  count, scheme version. Any window's p50 / p95 is a merge of rows. Client and server
  writes merge with one upsert that adds arrays element-wise.
- `latency_ledger_host_minute`: one row per minute: max decompressions/s, min free MB,
  max load, duress flag, slept flag. Pressure is computed at query time from these
  (`decompressions > 20,000/s or free < 200 MB or duress`), so the bar can be re-cut.
  Values come from the existing host health channel; no second `vm_stat`.
- `latency_ledger_page_load`: raw rows for page loads and navigations only (route,
  duration, cold, hidden, censored, subscription count, slowest resource). Low volume.
- Retention 35 days (minutes) and 7 days (raw) via `defineRetention`. All three tables
  declare `ExcludeFromFork`, so worktree forks do not copy them. Writes go through
  `createShedBuffer`.
- Flush: the server accumulates in memory and writes when the minute rolls over,
  driven by the health sampler's existing 10 s tick (a new `onHealthSample` seam).
  No new timer, and not a job: a job will soon run in another process and could not
  read this process's accumulator.

Honesty rules:

- A sample during which the tab was hidden is stored flagged and left out of
  percentiles. A load still unsettled after 60 s is stored as censored, not dropped.
  The card shows how many samples were excluded.
- Sleep: a 10 s window where the wall clock advanced more than 1.5 s beyond the
  monotonic clock marks the minute as slept; its samples are excluded. This relies on
  Bun's monotonic clock pausing during macOS sleep. Verified during rollout by logging
  both deltas; fallback is `sysctl kern.waketime` from the host sampler. The same test
  is given to the stall reporter so sleep stops filing stall reports.

Seams (no framework code imports the debug plugin):

- `plugins/primitives/plugins/live-state/web/pending-mount-tracker.ts` (new): a counter
  of mounted resources still without data. `use-resource.ts` gains two once-only calls
  on transitions it already computes for `slowResourceReportSink`.
- `plugins/primitives/plugins/live-state/web/notifications-client.ts`: read `changedAt`
  off update and delta frames, emit to a new report sink beside `slow-resource-reporter.ts`.
- `plugins/database/plugins/change-feed/server/internal/{triggers,parse-payload,route-change}.ts`:
  add `clock_timestamp()` in epoch ms to the notification payload and forward it. The
  trigger function is rebuilt at boot by fingerprint; no migration.
- `plugins/debug/plugins/health-monitor/server`: export `onHealthSample`.
- **Framework, needs approval (see decisions):**
  `plugins/framework/plugins/resource-runtime/core/runtime.ts`: `PendingNotify.changedAt`
  (earliest wins), threaded through `applyDbChange`, `mergePending`, `scheduleNotify`
  and the three frame builders next to `ackTx`.
  `plugins/framework/plugins/server-core/core/resources.ts`: `onResourceDelivery`, a
  second listener on `onDelivered`, copying the existing `onResourcePush` fan-out.
- Web collector mounted once at `Core.Root`, like `SlowOpCollector`. It accumulates the
  same histograms and posts once a minute and on `pagehide` to
  `POST /api/latency-ledger/client`. The old rAF-only page-load timer in
  `slow-op-collector.tsx` switches to the same settled condition.

Card: new plugin `plugins/stats/plugins/responsiveness`, one `Stats.Chart` contribution.
For 1 h / 24 h / 7 d: p50 and p95 per metric, calm beside pressure, sample and excluded
counts, share of 10 s windows with lag over 200 ms, and pass / fail against each exit
criterion, computed server-side. Refreshed by a scalar `latency-ledger.revision`
resource ticked on each flush (precedent: `runs.revision`). Percentile helper follows
`debug/profiling/boot-bench/server/internal/aggregate.ts`.

## Part C. Thread time by owner (build)

Answers "what runs on that thread, at what cost" continuously instead of once.

- Main already runs the JSC stack sampler all the time and drains it every 10 s
  (`health-monitor/server/internal/stall-profiler.ts`); the samples are thrown away
  unless a stall happened. Aggregate every drain by owner: the plugin of the innermost
  repo frame, else `node_modules:<package>`, else `native`. Samples × sampling interval
  is on-thread time. Reuse the owner classification idea from
  `tooling/checks/core/thread-watch.ts`.
- Stored per minute as top 20 owners plus "other", in the ledger plugin. Shown on the
  card as "share of the serving thread by owner". Config-gated; the aggregation's own
  cost is measured on the first deploy and reported.
- The wiki inventory maps each owner to serving or background by hand. Async
  continuations lose their root, so the ledger reports owners and does not pretend to
  know the origin.
- This number is the acceptance test of every phase of the split.

## Part D. Split design (wiki sub-page, no build this session)

Recommended direction, to be written up in full with the evidence:

- **Unit:** a second OS process on main only, same codebase, a third boot mode next to
  `serve` and `exec`. Not a Worker thread: macOS compresses memory per process, so only
  a separate address space lets the serving process stay small and hot; a native
  watcher crash is contained. Spawned by the serving backend after it is ready, in its
  process group (the gateway's restart reaps it, no Go change), at background priority,
  holding a per-namespace flock so a hot restart can never run two.
- **Cascade stays** in the serving process, now and later. It ends at the sockets, it
  was 2% of the window (942 cycles × 46 ms), and its invariants are the most delicate
  code in the repo. Its cost is set upstream by unbounded lists and per-row
  subscriptions.
- **Relay for the 25 push resources:** one frame `{key, params, affectedIds?, value?}`
  over a second Unix socket, and one required field `producer: "serving" | "background"`
  on `defineExternalResource`. Loaders that spawn, walk a tree or take a heavy-read slot
  may not run in the serving process. Lossy by design, closed by a slow reconcile frame.
  Relayed values carry an "as of" time.
- **API end state:** a `background/` runtime barrel; `onReady` removed from the server
  plugin definition; lint rules confining `setInterval`, `createFileWatcher`,
  `defineWarmup`, `spawn*`; a `serving-closure-clean` import-closure check. Shipped
  last, once the code has moved.
- **Phases:** 0 the two bug fixes plus Part C; 1 the process exists and owns the job
  queue (a role gate inside `jobs` only); 2 watchers, timers and the relay; 3 make it
  inexpressible; 4 decide about worktree backends from the numbers.
- **What it does not fix**, stated on the page: a no-op write causing full rebuilds,
  the resubscribe storm after a restart, and the 234-subscription page load. Those need
  the per-row subscription collapse, bounded lists and an invisible restart.
- **Biggest risk:** total memory goes up (two plugin graphs) on a machine that freezes
  under memory pressure. Phase 1 measures both footprints against a revert threshold
  named in advance.

## Part E. Follow-up tasks to file (`add_task`), not fixed here

1. Music-folder scan re-walks unchanged folders every 30 s.
2. Conversations poller runs once per backend instead of once per machine.
3. Sidebar sends three subscriptions per conversation row (about 130 of 234 per load).
4. File index refresh runs on every transcript write of every Claude session.
5. Split phase 1, after the user's decisions.
6. Continuation of the track (with the page id and the Track Instructions id).

## Verification

- `./equin build` in the background; read `build-status.json` for `status: ok`.
- `./equin test plugins/debug/plugins/latency-ledger`: histogram merge and
  percentile against a raw-array reference; hidden, censored and slept exclusion.
- Drive the deployed worktree with `e2e-harness/e2e/screenshot.ts` (cold load, then
  `--click` to another pane). Then `query_db`: a fresh row in
  `latency_ledger_page_load`, non-zero `page-load`, `navigate`, `deliver-server` and
  `thread-lag` rows in `latency_ledger_minute`, a `latency_ledger_host_minute` row.
- Update path: edit a task title in one tab with a second tab open; an `update-e2e`
  sample appears within the minute with a plausible value.
- Screenshot of the Stats card with numbers and pass / fail.
- Check that `get_runtime_profile` shows no new hot span from the ledger, and report
  the measured cost of the owner aggregation.

## Decisions that are the user's

1. **Framework edits.** `plugins/framework/CLAUDE.md` forbids changes there without
   approval in the conversation. Part B needs two: `changedAt` through
   `resource-runtime/core/runtime.ts`, and the `onResourceDelivery` listener in
   `server-core/core/resources.ts`. Without them `update-e2e` cannot be measured and the
   card would report the server-side value with a stated blind spot. Approving this plan
   approves these two edits.
2. **Split scope:** main only (recommended), every namespace, or only namespaces with an
   open tab.
3. **Memory trade:** accept two plugin graphs on main pending measurement, with a revert
   threshold (proposed: both processes together over 1.3× today's footprint).
4. **Order:** the two bug fixes before the split (recommended), so the split is not
   credited with their gain.
