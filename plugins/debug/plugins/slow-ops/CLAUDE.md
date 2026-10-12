# slow-ops

Durable, deduped store + recorder for slow operations, fed by server `onSlowSpan`
and the `POST /api/slow-ops/client` endpoint. Viewer: the `pane` sub-plugin
(Debug → Slow Ops), which reads the whole table through `GET /api/slow-ops`
(`listSlowOps`, in `core`). There is no live resource on purpose: `slow_ops` is
`ExcludeFromChangeFeed`, so a live read would never update.

Client `element` signals attribute to their route — they pass
`caller: { kind: "route", label: location.pathname }`, which the recorder merges
into the row's `callers` so the pane shows e.g. `↳ route:/agents/c/123 ×N`.

A server span's `detail` lands on the row too. Its `variant` merges into `variants`
(`◇ {"id":"42"} ×3`). Only the top 10 by total time stay named; the rest fold into
one `(other)` entry, so the row cannot grow without bound. Its `measures` merge into
`measures` as `{ max, last }` per measure (`# max 40 subscribers · last 12`). Both
are also stamped on the newest sample. The merges are pure (`merge-detail.ts`). The
cluster tab reads neither column (`ClusterSlowOpSchema`), so a fork still on the
older schema stays readable.

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
contention snapshot and one Postgres transaction (`recordSlowOpBatch`).

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

- Description: Records slow client operations (page load, element appearance) into the durable slow-op store via the slow-ops client endpoint. Durable slow-op store: deduped per-operation aggregates with caller attribution, plus the slow-op report kind. Subscribes to runtime-profiler slow spans and client signals; files one deduped report per distinct slow operation (investigation task filed on demand).
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "slow-op"
    - `Core.Root` → `SlowOpCollector`
    - `Reports.KindView` → `SlowOpKindView`
  - Uses:
    - `apps-core/tabs.navigate`
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
    - `ConfigV2.Register` "slow-op"
    - `report-kind` "slow-op"
    - `change-feed-exclusion` "slow_ops"
    - `fork-data-exclusion` "slow_ops"
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/jobs` ×4
    - `infra/entities` ×3
    - `config_v2` ×2
    - `infra/host/contention` ×2
    - `infra/host/duress` ×2
    - `primitives/log-channels` ×2
    - `reports` ×2
    - `database/admin.ExcludeFromFork`
    - `database/change-feed.ExcludeFromChangeFeed`
    - `database.db`
    - `debug/trace/engine.captureTrace`
    - `infra/endpoints.implement`
    - `infra/retention.defineRetention`
  - DB schema: `plugins/debug/plugins/slow-ops/server/internal/tables.ts`
  - Exports (types): `RecordSlowOpInput`
  - Exports (values):
    - `_slowOps`
    - `readSlowOpMarkers`
    - `recordSlowOp`
    - `recordSlowOpBatch`
  - Register: `defineJob('retention.slow_ops')`
  - Routes:
    - `GET /api/slow-ops`
    - `POST /api/slow-ops/client`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields/date/config.dateField`
    - `fields/float/config.floatField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.textField`
    - `fields/uuid/config.uuidField`
    - `infra/endpoints.defineEndpoint`
    - `infra/host/contention.ContentionSnapshotSchema`
    - `infra/runtime-profiler.SPAN_MEASURES`
    - `infra/runtime-profiler.SpanMeasure`
    - `infra/runtime-profiler.WaitBreakdown`
  - Exports (types):
    - `CallerBreakdown`
    - `CallerRef`
    - `MeasureStat`
    - `SlowOp`
    - `SlowOpMarker`
    - `SlowOpMeasures`
    - `SlowOpReportPayload`
    - `SlowOpSample`
    - `VariantBreakdown`
  - Exports (values):
    - `CallerBreakdownSchema`
    - `CallerRefSchema`
    - `listSlowOps`
    - `loadSeverity`
    - `MAX_CLIENT_SLOW_OP_ITEMS`
    - `OTHER_VARIANT`
    - `slowOpConfig`
    - `slowOpFields`
    - `SlowOpMarkerSchema`
    - `SlowOpMeasuresSchema`
    - `SlowOpReportPayloadSchema`
    - `SlowOpSampleSchema`
    - `SlowOpSchema`
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
  - **`pane`** [exempt] — Aggregates tab of the Slow Events pane: a global, ranked overview of slow operations with per-operation caller attribution.

<!-- AUTOGENERATED:END -->
