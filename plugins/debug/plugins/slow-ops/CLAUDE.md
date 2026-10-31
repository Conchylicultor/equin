# slow-ops

Durable, deduped store + recorder for slow operations, fed by server `onSlowSpan`
and the `POST /api/slow-ops/client` endpoint. Two tables:

- **`slow_ops`** — one row per (operationKind, operation, worktree): counters
  (count, total / max / last ms, threshold, first / last seen) plus four
  bounded JSON lists: `waits` (per layer), `variants` (top 10 + `(other)`),
  `measures` (`{ max, last }` per measure) and `recentSamples` (newest 10).
- **`slow_op_callers`** — one row per (op, caller): who issued the op, how often
  and how slow. Additive counters, nothing capped or folded.

Viewer: the `pane` sub-plugin (Debug → Slow Events → Aggregates), all live:

- `slow-ops.ops` — the ranked list, a scroll window (100 a page, `maxLimit`
  500) of slim rows: the counters, plus `waitMs` / `lastTraceId` derived in SQL.
  No JSON list reaches the list.
- `slow-ops.op` — one op by id (`useLiveRow`), for the detail pane a row opens.
- `slow-ops.callers` — that op's callers, scoped by its key, paged by total time.

## The write: one upsert per table per batch, merges in SQL

`recordSlowOpBatch` stamps and shed-gates each item, then folds the admitted
batch (`fold-batch.ts`, pure) into one row per op and one per (op, caller), and
writes each list as ONE `INSERT … ON CONFLICT DO UPDATE` through its change
producer (`producer.ts`). Every merge — counters, the newest-occurrence guards,
the four JSON lists — is a SQL expression in the SET clause
(`merge-sql.ts`), evaluated against the row ON CONFLICT locked: no read-back,
no JS under a lock, safe across the two backends of a hot swap (each batch is
sorted by key, so they lock in the same order). The SQL merges mirror the pure
ones (`fold-batch.ts`, `merge-detail.ts`); `record-slow-op.test.ts` checks
fold + SQL against the old per-item merge over random batches.

**Why this shape.** The previous recorder upserted the counters, read the row
back, merged five JSON lists in JS and rewrote the row — two statements per
occurrence inside one transaction. That could not be a change producer
(`mutate` is one autocommit statement), and with a trigger it was the largest
source of change-feed churn: a self-amplifying loop (slow app → more slow-op
writes → more notify cascade → slower app). So the table was
`ExcludeFromChangeFeed` and the pane re-read the whole table (~19 MB) on open.
Now both tables are change producers: no trigger, no changelog, no NOTIFY, and
at most one flush per 2 s per table however many occurrences land
(`coalesce`), each refilling only the changed ids of the open windows. The
writes stay inside `runWithoutProfiling` and the background lane.

**Callers live in their own table** because they are the one list with
unbounded cardinality (a route path carries ids: the worst op had 457
callers). Capping them like `variants` would have folded about 30% of all named
callers into `(other)` (measured on main, 2026-10-13); as rows they stay exact
and the detail pages them. `slow_op_callers` names its op by the text key, not
`slow_ops.id` — the recorder never looks the op up, and the detail's window
filters text columns (the live filter cannot compare a text operand with a
`uuid` column). No foreign key: retention ages a caller out on its own
`last_seen_at`, which is never later than its op's. Callers used to be a JSON
`callers` column on `slow_ops`; a one-time backfill copied it into
`slow_op_callers` and a later push dropped it (callers the outgoing backend
merged during that one hot-swap window were not copied — seconds of
attribution; the op's counters include them).

The client signals are `page-load`, `element` (a resource's mount → first data)
and every client latency signal of `primitives/perfs/latency-signal` (`update`,
`confirm`, …; see "Client latency kinds" below). All but `page-load` attribute to
their route — they pass `caller: { kind: "route", label: location.pathname }`,
which lands on the op's `slow_op_callers` row (`route` · `/agents/c/123` ×N in
the detail).

An `element` item (`elementSlowOp`, `web/internal/element-slow-op.ts`) follows
the same identity rule as the latency kinds below: `operation` is the resource
key alone, and the tuple's `canonicalJson(params)` is its `detail.variant`, so a
resource slow on many tuples (one per conversation, one per page) is one row and
one report, its tuples kept in `variants`. Rows recorded before this change name
`<key> <params>` as their operation and remain as history.

A server span's `detail` lands on the row too: its `variant` merges into
`variants` (only the top 10 by total time stay named; the rest fold into one
`(other)` entry, on the batch that creates the row as on every merge) and its
`measures` into `measures`. Both are also stamped on the newest sample. The
cluster tab reads only the columns its merge uses (`ClusterSlowOpSchema`, an
explicit pick), so a fork on any schema stays readable.

## Own time — a report names an op that was itself slow

Every item is judged on its **own time** (`ownMs`): its duration less the time
it did not spend working. `recordSlowOpBatch` drops an item whose own time is
under its bar. That is the one filter in the funnel, and it applies to every
producer. The excluded time is never discarded silently. It stays in the
item's `waits`, on its own layer, and it is either not the system's time at
all or it is charged to the op that owns it:

| Excluded | Where it is measured | Who owns it |
|---|---|---|
| A server span's gate waits (`waitMs`) | `slowSpanMs` (resolve-threshold.ts), every kind | The gate. A `queue` wait at or past `loaderMs` files `wait <layer>` (`onSlowWait`): one row per gate, its waiters as callers. A `join` wait (an identical run in flight) is that run's, which reports itself. |
| A span's time inside an enclosed op already filed (`claims`) | `slowSpanMs` over the profiler's `excludedMs` | That op, filed once (see "One cause, one report"). |
| A delivery's wait on its flush's filed ops, and its `throttle-hold` | `deliver:<key>` is a latency leaf (`recordSpan(…, { latency: true })`) | The filed op; the hold is declared. |
| An update's `throttle-hold` | `EXCLUDED_PHASES` / `ownMsOf` (perfs/latency-signal) | Nobody. The resource declared the hold (`throttleMs`). |
| An update's `server-deliver` (notify → send) | `EXCLUDED_PHASES` / `ownMsOf` | The server: exactly the window its `push deliver:<key>` span judges (and the loader or flush it waited on). |
| An element's transport bring-up (`notifications-transport`) | `elementSlowOp` | The transport. It is filed once per page as `wait notifications-transport` (`transportSlowOp`). |
| Main-thread stalls ≥ 1 s (`main-thread-stall`) | `judgePagePauses` at the queue's flush, via perfs/page-pauses | main-thread-stall, which files the frozen page as its own `main-thread` op. |
| A hidden or frozen tab (`page-hidden`) | The same | Nobody. Only the hidden part is taken off — a throttled tab measures the browser — and the visible rest is still judged, so a slow op spanning a brief tab switch is still reported. |
| Machine sleep (`sleep`) | `withoutSleep` in the client handler, over the item's `endedAt` window (machine-sleep's `sleptDuring`) | Nobody. Only the sleep beyond the item's `page-hidden` time comes off (a nap usually hides the tab, and the two cannot be placed against each other server-side), so one nap is never taken off twice. A server span needs none: Bun's `performance.now()` stops while the machine sleeps (measured 2026-10-30). |

Why: the 2026-10-29 audit of main found reports blaming ops for time they
spent not working:

- `sub` spans were 85% `read-admit` queue.
- `update queue-health.pulse ~1002ms` was its own 1000 ms throttle against
  the 1000 ms bar.
- `update tasks 69 s` happened inside a 273 s frozen tab.
- `element` settles were dominated by transport bring-up.

**Cold-start slowness stays loud**, on the op that owns it. A slow boot wave
used to land on whichever resource happened to mount (`sonata-key-auto-detect`
"slow" while the socket was still coming up). Now each resource is judged on
what remained after the transport was ready, and the bring-up itself is one
`wait notifications-transport` report per page. A cluster of those right after
a hot swap is still a readiness defect to fix at the source (the gateway swaps
only after `GET /api/health/ready`; see `gateway/CLAUDE.md` and
`research/2026-06-14-global-cold-load-instant-boot.md`). The element item
still carries `transportColdStart` and its wait, so its report says what was
taken off.

Storage is unchanged. Rows keep wall-clock `durationMs` / `totalMs` / `maxMs`
plus the per-layer `waits`, so the list's Wait column shows the excluded share.
The report's `ownMs` drives its title and message ("1502ms own of 2500ms").
Design: `research/2026-10-30-global-slow-op-own-time.md`.

## One cause, one report

Own time removes what an op did not do; the same rule, applied to ops that
CONTAIN each other, keeps one slowness from being filed once per measurement
that saw it. On main after own-time landed (2026-10-30 13:57:21), one 2.66 s
`edited-files` load filed 14 fingerprints: the loader, its `push`, the `flush`,
the watcher's `bg` pass, four `deliver:*` (two of them `notifications`, which
only waited in the same cycle) and four client `update`s. Now:

- **The innermost slow op is filed; what encloses it is judged without it.**
  The install hook calls the profiler's `claim()` on every span it files, and
  the profiler takes that span's interval off every open enclosing entry
  (`excludedMs`, `claims` — runtime-profiler, "Claims"). The row's `waits` name
  the claimed op as a layer (`loader edited-files 2600`), so an enclosing span
  still filed shows what was taken off.
- **A delivery is a latency, not work.** `deliver:<key>` subtracts its declared
  `throttle-hold` and the claims its flush collected inside its window; it is
  filed only when slow for a reason nothing else reported, so it stays the
  end-to-end server measure — held to `updateMs` (the bar of the client half it
  replaces, below), not `loaderMs`.
- **The client does not re-file the server's window.** An update's
  `server-deliver` is that same window, so `ownMsOf` excludes it
  (`EXCLUDED_PHASES`, owner `server`); the update is judged on `server-notice +
  transport + client-apply`, and the server's delivery on the same 1000 ms bar. An `element` carries no server split on the wire, so
  it still counts the server's `sub` time.
- **A batch's burst is one incident, not one report** (`incidentsFor`,
  `server/internal/report-groups.ts`). A client batch (one tab's 250 ms window)
  with several items of one kind is one incident — a stalled socket delivers
  every pending update late, a page boot settles every element late — so it
  rings the bell ONCE (`recordReportIncident`, reports/engine: the first
  never-seen op's report if any, else the slowest's). Each distinct op still
  files its OWN report (`slow-op:<kind>:<operation>`), carrying `burst` (the
  batch's count and slowest few), so unrelated incidents never share a row and
  an op that only ever trips beside others is still reported. (A one-fingerprint
  `slow-op:<kind>:burst` report did both wrong; its old rows still render.)
  Server spans reach the funnel one per batch, so each is its own incident.
  Design: `research/2026-10-31-global-slow-op-burst-incident.md`.
- **A warm-up is judged once**, here, on its `bg` span (against its declared
  `budgetMs` or `DEFAULT_WARMUP_BUDGET_MS`); boot-budget no longer judges its
  boot span.

Design: `research/2026-10-30-global-slow-op-one-cause-one-report.md`.

## The client beacon is batched

The browser does not POST once per slow element. `web/internal/slow-op-queue.ts`
queues each signal, waits ~250 ms (one trailing debounce, never a poll), and
sends the accumulated items as ONE request, chunked to
`MAX_CLIENT_SLOW_OP_ITEMS`, `keepalive`, with a `pagehide` flush so a queued
signal is not lost when the tab goes away. Each batch retries a network error or
502/503/504 for ~31 s (the reports beacon's budget), so a backend restart — main
restarts on every push — no longer surfaces as a `Failed to fetch` crash. On the server, one batch is one
contention snapshot and one upsert per table (`recordSlowOpBatch`) — never a
transaction per item.

This exists because the old shape amplified the very stall it reported: during
the 2026-09-02 incident a reconnect re-settled ~420 resources at once, and the
op-rate monitor recorded `POST /api/slow-ops/client — 43.2s across 438 calls`,
each call a DB transaction plus a report upsert plus a notification insert,
against the backend that was already failing. See
`research/2026-09-02-global-alert-fan-out-ceiling.md`.

**Batching is a transport change, plus one judgement.** An item queued with
its wall-clock window (every element and latency sample) is judged against the
page's pauses inside it at the flush (`judgePagePauses`, see "Own time"). That
is the only place late enough to ask, because a long frame's entry arrives
after the frame. Nothing else is filtered, thresholded, deduped or delayed out
of existence on the way. The only other loss the queue can cause is its
1000-item cap, and that loss is counted and sent as the batch's `dropped`
field, which the handler writes to the `slow-ops` log channel — never silently
discarded.

`recordSlowOp(input)` is `recordSlowOpBatch([input])`, so the server-span hook
and the client beacon remain ONE funnel with one set of semantics.

## Client latency kinds

`web/components/slow-op-collector.tsx` holds ONE subscriber on
`clientLatencySink` (`primitives/perfs/latency-signal`) for the whole signal
vocabulary — it never names `update` or `confirm`. Each sample becomes an item
through the pure `latencySlowOp` (`web/internal/latency-slow-op.ts`):

| item field | from the sample |
|---|---|
| `operationKind` | the signal (`update`, `confirm`) |
| `operation` | the resource key only, so one resource stays one row |
| `detail.variant` | the sample's `variant` (a confirm's `mode/edge`), else `canonicalJson(params)` — merged into the row's `variants` |
| `waits` | the signal's phases (`server-notice` / `throttle-hold` / `server-deliver` / `transport` / `client-apply`; `send-lane` / `retry` / `server-ack` / `confirm-frame`) — merged into the row's durable `waits` |
| `caller` | the current route |
| `durationMs` | `totalMs` (measured end − start; the clamped phases can sum to more) |
| `ownMs` | `ownMsOf(sample)`: `totalMs` less its held phases (an update's `throttle-hold`) |

- **Thresholds** are the `updateMs` (1000, the ledger's calm p95 bar) and
  `confirmMs` (2000) knobs, picked per signal by `CLIENT_SIGNAL_THRESHOLD` in
  `core/config.ts` — a `Record` over the signal union, so a new signal does not
  compile without its knob. They stay **out of `perfFloorMs`**: that floor
  pre-filters server spans, which no client knob ever judges, so a client knob
  there would only lower the profiler floor for every server span.
- **The time a sample spent hidden is taken off its own time** (the
  `page-hidden` layer), judged at the queue's flush from page-pauses over the
  sample's window (`[emit − totalMs, emit]`). No producer tracks visibility. A
  throttled tab measures the browser, not the system; the visible rest is
  still the op's. The page's pauses are subtracted from own time as given:
  they are not placed against the sample's own excluded phases (a
  `throttle-hold` the tab was also hidden through comes off twice), an
  accepted under-count.
- **One sample per tab.** Each visible tab reports its own sample of the same
  change, so a row's count includes every tab; the route caller shows which
  surface each came from. Documented, not deduplicated.
- **One trace per (batch, kind).** A stalled change arrives as a burst of samples;
  `toRecordInputs` (`server/internal/client-record-input.ts`) captures one trace
  per `operationKind` per batch — the slowest item's — and links every item of
  that kind to it, so a burst cannot spend the trace engine's global per-minute
  budget. The same rule now covers `element` and `page-load`.
- **The report names the dominant layer.** The report payload carries the trip's
  `waits`; `describeWaits` (`server/internal/wait-layers.ts`) names the largest
  layer, its share of the trip and a hint from `WAIT_LAYER_HINTS` (keyed by layer
  name, never by kind), then lists every layer. It applies to every kind that
  carries waits, server spans included.

## A declared budget wins (`SlowSpan.budgetMs`)

A span may carry the bar its call site declared: `runTracked(label, fn,
{ budgetMs })` for a background span, and a warm-up's `defineWarmup({ budgetMs })`,
which the warm-up executor stamps on its `bg` span (`DEFAULT_WARMUP_BUDGET_MS`
when it declares none — slow-ops is a warm-up's one judge). `resolveSlowThreshold` returns it ahead of every kind
default — the work said how long it is expected to take, and judging it on a
global knob (`loaderMs` for every `bg` span) filed reports against work that was
on budget (`warmup:plugin-tree.trees`, budget 15 s, ~6 s; `task-title:generate`,
a Haiku call bounded by its own 30 s timeout, judged on 2 s). Declare a model
call's, fetch's or subprocess's bound by deriving it from the timeout constant
it already passes, so the two cannot drift. Like `slowThresholdMs`, a budget
below `perfFloorMs` is not honored.

## Slow jobs (the `job` kind)

Background job runs flow through the same pipeline as HTTP/loader ops. The jobs
dispatcher records each `job.run()` as a `job` span (label = the job name), so a
run slower than its threshold files **one deduped report per job name**
(fingerprint `slow-op:job:<jobName>`) with caller attribution, exactly like a
slow route (an investigation task is filed on demand from Debug → Reports).

The threshold is the job's declared **hold class ceiling** —
`defineJob({ hold })`, 10 s / 2 min / 30 min (`jobs/core/hold.ts`). That is what
makes a wrong `hold` loud: a job declaring `instant` and spending 10 s working
files a report naming itself, every tick, until it is reclassified or fixed. A
job expected to run long still raises its own bar with
`defineJob({ slowThresholdMs })`, which wins outright; the `slow-op` config
`jobMs` (default **3000 ms**) is the fallback for a job name this backend has no
registration for — a queue row written by a plugin this composition does not
load.

**A job is judged on WORK time (`durationMs − excludedMs`), not on wall-clock hold**
— as every span kind now is (see "Own time"). A job's slot-hold is substantially not a property
of the job: `jobs.dead-gc` was measured holding a worker slot 77 s to do 254 ms
of work, the rest blocked on `background-tx-acquire`, an admission gate entered
*after* graphile had handed it a slot. Judging hold would file a report against a
correctly-classified job every time that gate got busy. Both halves of the
decision — which quantity (`slowSpanMs`) and which bar
(`resolveSlowThreshold`) — live in `resolve-threshold.ts`; see
`plugins/infra/plugins/jobs/CLAUDE.md` § "Hold class". The recorded row still
carries wall-clock `durationMs` plus its per-layer `waits`, so the split stays
readable off the row.

The profiler pre-filter floor is `perfFloorMs` — `min(config thresholds, class
ceilings)`, so a class ceiling below a config knob is still reachable. A per-job
`slowThresholdMs` below that floor is still not honored, which remains a
non-issue for the expected-slow-job use case (the override is meant to raise the
bar).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Records slow client operations (page load, element appearance, and every client latency signal — a live update applied, an optimistic write confirmed — split into its phases) into the durable slow-op store via the slow-ops client endpoint. Durable slow-op store: deduped per-operation aggregates and their callers (one row per op × caller), both written through change producers, plus the slow-op report kind and the live collections the pane reads (slow-ops.ops list, slow-ops.op detail, slow-ops.callers). Subscribes to runtime-profiler slow spans and client signals; files one deduped report per distinct slow operation (investigation task filed on demand).
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "slow-op"
    - `Core.Root` → `SlowOpCollector`
    - `Reports.KindView` → `SlowOpKindView`
  - Uses:
    - `apps-core/tabs.useAppLink`
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `infra/endpoints.fetchEndpointOver`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `primitives/css/link-chip.LinkChip`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/live-state.slowResourceReportSink`
    - `primitives/networking/page-transport.pageTransport`
    - `primitives/pane.currentRoutePath`
    - `primitives/perfs/boot-trace.getBootTrace`
    - `primitives/perfs/page-pauses.pausesDuring`
    - `reports.Reports`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `resource.declare` "slow-ops.callers"
    - `resource.declare` "slow-ops.callers:groups"
    - `resource.declare` "slow-ops.callers:rows"
    - `resource.declare` "slow-ops.op:rows"
    - `resource.declare` "slow-ops.ops"
    - `resource.declare` "slow-ops.ops:groups"
    - `resource.declare` "slow-ops.ops:rows"
    - `ConfigV2.Register` "slow-op"
    - `report-kind` "slow-op"
    - `change-producer` "slow_op_callers"
    - `change-producer` "slow_ops"
    - `fork-data-exclusion` "slow_op_callers"
    - `fork-data-exclusion` "slow_ops"
  - Uses: 26 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/jobs` ×4
    - `infra/entities` ×3
    - `config_v2` ×2
    - `infra/host/contention` ×2
    - `infra/host/duress/shed` ×2
    - `reports/engine` ×2
    - `database/admin.ExcludeFromFork`
    - `database/change-feed.defineChangeProducer`
    - `database.db`
    - `debug/trace/engine.captureTrace`
    - `infra/endpoints.implement`
    - `infra/host/machine-sleep.sleptDuring`
    - `infra/retention.defineRetention`
    - `network/live.serveCollection`
    - `primitives/log-channels/log-files.readChannelJsonAsync`
    - `primitives/log-channels.defineLogSink`
    - `reports.ReportKind`
  - DB schema: `plugins/debug/plugins/slow-ops/server/internal/tables.ts`
  - Exports (types): `RecordSlowOpInput`
  - Exports (values):
    - `_slowOps`
    - `readSlowOpMarkers`
    - `recordSlowOp`
    - `recordSlowOpBatch`
  - Register:
    - `defineJob('retention.slow_ops')`
    - `defineJob('retention.slow_op_callers')`
  - Resources:
    - `slow-ops.callers` (keyed, window)
    - `slow-ops.callers:groups` (push)
    - `slow-ops.callers:rows` (keyed, point)
    - `slow-ops.op:rows` (keyed, point)
    - `slow-ops.ops` (keyed, window)
    - `slow-ops.ops:groups` (push)
    - `slow-ops.ops:rows` (keyed, point)
  - Routes: `POST /api/slow-ops/client`
- Core:
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `fields` ×3
    - `infra/runtime-profiler` ×3
    - `config_v2` ×2
    - `network/live` ×2
    - `packages/list-bound` ×2
    - `debug/trace/engine.traceListRoute`
    - `fields/date/config.dateField`
    - `fields/duration/config.durationField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.textField`
    - `fields/uuid/config.uuidField`
    - `infra/entities.entityRef`
    - `infra/host/contention.ContentionSnapshotSchema`
    - `primitives/pane.defineRoute`
    - `primitives/report-sink.defineObservationSink`
  - Exports (types):
    - `CallerRef`
    - `ClientSlowOpSignal`
    - `MeasureStat`
    - `SlowOp`
    - `SlowOpCaller`
    - `SlowOpCallerListRow`
    - `SlowOpListRow`
    - `SlowOpMarker`
    - `SlowOpMeasures`
    - `SlowOpReportPayload`
    - `SlowOpSample`
    - `VariantBreakdown`
  - Exports (values):
    - `CallerRefSchema`
    - `CLIENT_SIGNAL_THRESHOLD`
    - `clientSlowOpSink`
    - `isLegacyBurstReport`
    - `loadSeverity`
    - `MAX_CLIENT_SLOW_OP_ITEMS`
    - `MAX_SLOW_OP_MARKERS`
    - `OTHER_VARIANT`
    - `slowOpById`
    - `slowOpCallerFields`
    - `slowOpCallers`
    - `SlowOpCallerSchema`
    - `slowOpCallersEntityRef`
    - `slowOpConfig`
    - `slowOpDetailRoute`
    - `slowOpFields`
    - `SlowOpMarkerSchema`
    - `SlowOpMeasuresSchema`
    - `SlowOpReportPayloadSchema`
    - `SlowOpSampleSchema`
    - `SlowOpSchema`
    - `slowOpsEntityRef`
    - `slowOpsList`
    - `VARIANT_CAP`
    - `VariantBreakdownSchema`
- Cross-plugin:
  - Uses tokens: `ui/tokens/color-palette --muted-foreground`
  - Imported by:
    - `debug/boot-monitor`
    - `debug/health-monitor`
- Exemptions:
  - Exempts itself from:
    - `sink-safety/no-adhoc-profiler-seam` — `.` (sanctioned)
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `networking/no-page-transport` — `web/internal/slow-op-queue.ts` (sanctioned)
- Sub-plugins:
  - **`cluster`** [exempt] — Cross-worktree Cluster tab for the Slow Events pane: fans out across every worktree DB fork and merges them into one aggregate + a unified contention timeline. Cross-worktree cluster scan: every…
  - **`pane`** — Aggregates tab of the Slow Events pane: a live, paged ranking of slow operations, and the per-operation detail pane (callers, waits, variants, measures, recent samples).

<!-- AUTOGENERATED:END -->
