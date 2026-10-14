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
`last_seen_at`, which is never later than its op's.

**The legacy `callers` column** on `slow_ops` is no longer read or written. It
outlives this change by one push only because a hot swap's outgoing backend
still names it in its upsert; the follow-up push drops it. The backfill copied
it into `slow_op_callers` once, at the new backend's boot; callers the
outgoing backend merged into it during that swap window were not copied (a
few seconds of attribution; the op's counters include them).

Client `element` signals attribute to their route — they pass
`caller: { kind: "route", label: location.pathname }`, which lands on the op's
`slow_op_callers` row (`route` · `/agents/c/123` ×N in the detail).

A server span's `detail` lands on the row too: its `variant` merges into
`variants` (only the top 10 by total time stay named; the rest fold into one
`(other)` entry, on the batch that creates the row as on every merge) and its
`measures` into `measures`. Both are also stamped on the newest sample. The
cluster tab reads only the columns its merge uses (`ClusterSlowOpSchema`, an
explicit pick), so a fork on any schema stays readable.

## Cold-start slowness is UX truth — don't suppress it

The `element` signal measures a resource's mount → first-data settle = the
**time-to-content** the user waits through on a fresh load. A slow boot wave is a
**real UX regression, not noise** — never filter the post-deploy burst.

It shouldn't happen: the gateway hot-swaps only after `GET /api/health/ready`
returns `200` (post `onReadyBlocking` barrier: migrations + pool/table warm-up),
so "ready" means the next request is *fast*. A cluster of slow ops right after a
swap = readiness flipped too early → a **readiness/hot-swap defect to fix at the
source**, never to mute. See `gateway/CLAUDE.md`, `plugins/database/CLAUDE.md`,
and `research/2026-06-14-global-cold-load-instant-boot.md`.

### Transport cold-start attribution (enrich, don't suppress)

A resource's mount → first-data settle is ~100% wait on the notifications
transport (the client does no compute — it awaits the server value). On a cold
deep-link the socket itself comes up late (its cross-tab-election `onElected` is
starved by cold-boot main-thread saturation), so the settle wall-clock lands on
whichever resource happened to mount — mislabelling e.g. `sonata-key-auto-detect`
as "slow" when nothing about that resource is slow. To keep the signal honest
**without suppressing it**, the `element` signal now carries additive root-cause
attribution: `useResource` reads `NotificationsClient.getFirstReadyAt()` and, when
the transport was not ready at mount, reports `transportColdStart` + the
bring-up `transportWaitMs`. The server charges that wait to a
`notifications-transport` layer in the durable `waits` (wait-vs-work split, no
migration) and stamps `transportColdStart` into the report `data`, so the task
title gains `— transport cold-start` and the description points the fix at
transport/boot readiness rather than the resource. The full duration still fires
and is still recorded — this is *attribution*, not a filter.

## The client beacon is batched — transport only

The browser does not POST once per slow element. `web/internal/slow-op-queue.ts`
queues each signal, waits ~250 ms (one trailing debounce, never a poll), and
sends the accumulated items as ONE request, chunked to
`MAX_CLIENT_SLOW_OP_ITEMS`, `keepalive`, with a `pagehide` flush so a queued
signal is not lost when the tab goes away. On the server, one batch is one
contention snapshot and one upsert per table (`recordSlowOpBatch`) — never a
transaction per item.

This exists because the old shape amplified the very stall it reported: during
the 2026-09-02 incident a reconnect re-settled ~420 resources at once, and the
op-rate monitor recorded `POST /api/slow-ops/client — 43.2s across 438 calls`,
each call a DB transaction plus a report upsert plus a notification insert,
against the backend that was already failing. See
`research/2026-09-02-global-alert-fan-out-ceiling.md`.

**Batching is a transport change and nothing else.** No signal is filtered,
thresholded, deduped or delayed out of existence on the way — every element
settle that trips today still reaches `recordSlowOp` with the same
`transportColdStart` / `transportWaitMs` / `caller` / `clientBoot` attribution,
and the section above still holds in full. The only loss the queue can cause is
its 1000-item cap, and that loss is counted and sent as the batch's `dropped`
field, which the handler writes to the `slow-ops` log channel — never silently
discarded.

`recordSlowOp(input)` is `recordSlowOpBatch([input])`, so the server-span hook
and the client beacon remain ONE funnel with one set of semantics.

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

**A job is judged on WORK time (`durationMs − waitMs`), not on wall-clock hold**
— alone among the span kinds. A job's slot-hold is substantially not a property
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Records slow client operations (page load, element appearance) into the durable slow-op store via the slow-ops client endpoint. Durable slow-op store: deduped per-operation aggregates and their callers (one row per op × caller), both written through change producers, plus the slow-op report kind and the live collections the pane reads (slow-ops.ops list, slow-ops.op detail, slow-ops.callers). Subscribes to runtime-profiler slow spans and client signals; files one deduped report per distinct slow operation (investigation task filed on demand).
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "slow-op"
    - `Core.Root` → `SlowOpCollector`
    - `Reports.KindView` → `SlowOpKindView`
  - Uses:
    - `apps-core/tabs.appLink`
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `infra/endpoints.fetchEndpoint`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `primitives/css/link-chip.LinkChip`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/live-state.slowResourceReportSink`
    - `primitives/pane.currentRoutePath`
    - `primitives/perfs/boot-trace.getBootTrace`
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
  - Uses: 24 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/jobs` ×4
    - `infra/entities` ×3
    - `config_v2` ×2
    - `infra/host/contention` ×2
    - `infra/host/duress` ×2
    - `primitives/log-channels` ×2
    - `reports` ×2
    - `database/admin.ExcludeFromFork`
    - `database/change-feed.defineChangeProducer`
    - `database.db`
    - `debug/trace/engine.captureTrace`
    - `infra/endpoints.implement`
    - `infra/retention.defineRetention`
    - `network/live.serveCollection`
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
  - Uses:
    - `config_v2.defineConfig`
    - `debug/trace/engine.traceListRoute`
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields/date/config.dateField`
    - `fields/float/config.floatField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.textField`
    - `fields/uuid/config.uuidField`
    - `infra/host/contention.ContentionSnapshotSchema`
    - `infra/runtime-profiler.SPAN_MEASURES`
    - `infra/runtime-profiler.SpanMeasure`
    - `infra/runtime-profiler.WaitBreakdown`
    - `network/live.liveCollection`
    - `network/live/filter.liveInstant`
    - `network/live/filter.liveNumber`
    - `network/live/filter.liveText`
    - `primitives/pane.defineRoute`
  - Exports (types):
    - `CallerBreakdown`
    - `CallerRef`
    - `MeasureStat`
    - `SlowOp`
    - `SlowOpCaller`
    - `SlowOpDetail`
    - `SlowOpListRow`
    - `SlowOpMarker`
    - `SlowOpMeasures`
    - `SlowOpReportPayload`
    - `SlowOpSample`
    - `VariantBreakdown`
  - Exports (values):
    - `CallerBreakdownSchema`
    - `CallerRefSchema`
    - `loadSeverity`
    - `MAX_CLIENT_SLOW_OP_ITEMS`
    - `OTHER_VARIANT`
    - `slowOpById`
    - `slowOpCallerFields`
    - `slowOpCallers`
    - `SlowOpCallerSchema`
    - `slowOpConfig`
    - `slowOpDetailRoute`
    - `SlowOpDetailSchema`
    - `slowOpFields`
    - `SlowOpListRowSchema`
    - `SlowOpMarkerSchema`
    - `SlowOpMeasuresSchema`
    - `SlowOpReportPayloadSchema`
    - `SlowOpSampleSchema`
    - `SlowOpSchema`
    - `slowOpsList`
    - `VARIANT_CAP`
    - `VariantBreakdownSchema`
- Cross-plugin:
  - Imported by:
    - `debug/boot-monitor`
    - `debug/health-monitor`
- Exemptions:
  - Exempts itself from:
    - `sink-safety/no-adhoc-profiler-seam` — `.` (sanctioned)
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
- Sub-plugins:
  - **`cluster`** [exempt] — Cross-worktree Cluster tab for the Slow Events pane: fans out across every worktree DB fork and merges them into one aggregate + a unified contention timeline. Cross-worktree fan-out endpoint…
  - **`pane`** — Aggregates tab of the Slow Events pane: a live, paged ranking of slow operations, and the per-operation detail pane (callers, waits, variants, measures, recent samples).

<!-- AUTOGENERATED:END -->
