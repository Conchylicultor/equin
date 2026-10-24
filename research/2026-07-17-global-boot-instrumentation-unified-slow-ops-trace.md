# Unify boot instrumentation into the slow-ops + trace-engine surface

## Context

A freshly-built worktree takes >10s to display on first visit. Investigation (this
session) decomposed the cold-load path into three stages — **gateway readiness wait →
server boot → browser boot** — and found each instrumented separately, with no unified
per-incident view and one total blind spot:

- **Gateway wait** (spawn → `/api/health/ready`, load-adaptive 15–90s+ deadline) exists
  only as `slog` lines (`gateway/worktree.go:961,982`) — not persisted, not queryable.
- **Server boot** has an in-process span profile (`getProfilingData()`), the
  `boot.jsonl` disk floor (boot-events), and per-span budgets (boot-budget) — but no
  whole-boot incident record, no trace, no slow-op row.
- **Browser boot** has a rich in-memory `BootTrace` (perfs/boot-trace) and the
  page-load slow-op beacon — but the beacon's trace carries only *server* lanes; the
  client's own decomposition never rides along and is ephemeral unless a human clicks
  "Copy permalink" in Debug → Boot Profile.

Meanwhile the unified perf surface already exists as a **pair** (`trace/CLAUDE.md`):
`slow_ops` = aggregates + thresholds + reports bell; `traces` = per-incident evidence
in Debug → Slow Events, with an **open** `TraceEventClass` registry and open trigger
kind / operationKind vocabularies (verified: nothing closes over kinds anywhere — a new
kind renders end-to-end via `GenericEventLane` / `GenericTriggerSummary` fallbacks with
zero registrations).

**Intent:** boot joins that pair as **trigger-owned trace sections** (the `stall`
precedent: producer pre-aggregates, passes the section in `trigger.detail`, the class
is a schema-validating passthrough — `trace/plugins/stall/server/internal/class.ts`),
plus `recordSlowOp` rows under a new open kind. The wedge-visible disk floor
(`boot.jsonl`) stays file-based and backend-write-only.

## Resolved design decisions

- **D1 — Server mint point: new sibling monitor plugin `debug/boot-monitor`.** Not
  server-core (framework `bin` importing `debug/trace` + `debug/slow-ops` is a layering
  violation), not boot-budget (its config/job/kind literals are a documented per-span
  charter). Follows the one-signal-one-plugin debug-monitor precedent (`stall-monitor`,
  `read-set-shrink`); the job copies boot-budget's shape byte-for-byte (per-worktree
  minute cron, `dedup: "singleton"`, `maxAttempts: 3`, module-level per-boot dedup —
  process lifetime = boot epoch).
  **Completeness guard:** `profilerStart()` pushes a span only when its `end()` closure
  runs (`server-core/core/profiler.ts:77-88`), so the presence of a
  `phase === "drainWarmups"` span in `getProfilingData().spans` is a deterministic
  "boot fully complete" signal; the job skips ticks until it appears.
- **D2 — Signal shape.** `operationKind: "boot"`, `operation: "server-boot"` (slow_ops
  conflict key includes worktree → one aggregate row per worktree; `count` = slow-boot
  count). `durationMs` = profiler `totalDurationMs` (deterministic, version-independent);
  the gateway-observed wait is section *evidence*, never the trip metric. Trigger:
  `captureTrace({ kind: "boot", label: "server-boot", detail: BootSection })` — the 10s
  `kind:label` cooldown dedupes crash-loops. Threshold: producer-owned
  `totalBootBudgetMs` (default 10 000) in the new plugin's own config. **Trip-only**: no
  trace/row for within-budget boots (Debug → Boot Profile stays the always-on deep-dive).
- **D3 — Report source.** Add `"server-boot-monitor"` to `SERVER_REPORT_SOURCES`
  (`plugins/reports/core/sources.ts` — derived-array pattern) and widen the
  `SlowOpSource` `Extract` (`record-slow-op.ts:31`).
- **D4 — Gateway handoff: post-ready POST, fire-and-forget.** After the proxy swap in
  both `Ensure` and `Restart` success paths, the gateway POSTs
  `{spawnRequestedAt, spawnedAt, readyObservedAt, escalated, respondedHTTP, demoted}`
  (epoch ms) to `POST /api/boot/gateway-report` over the unix socket (it already holds
  that client pattern in `waitReady`, `gateway/worktree.go:1017-1026`). The backend
  stores it in a module-level box the monitor reads at mint time — the POST lands
  ~100ms after readiness, the mint at the next minute tick, so ordering holds by
  construction. Version tolerance both ways: older gateway → no POST → `section.gateway`
  is `optional()`; newer gateway + older backend → 404 → `slog` note, boot unaffected.
  Chosen over extending the pid sidecar because the sidecar has no ordering signal and
  couples two lifecycles. **`boot.jsonl` untouched** — an HTTP datum to a live backend
  can never strengthen the wedge-visible floor.
- **D5 — Browser boot rides the existing `"page-load"` trigger; ONE beacon, keepalive
  kept.** Additive optional `clientBoot` field on `SlowOpClientBodySchema` (the
  documented `transportColdStart` precedent), built by a pure
  `toClientBootSection(getBootTrace())` trimmer (full spans ≈6KB + nav/paint/longTasks
  + top-20 assets by transferSize + aggregate rollup ≈ 12–15KB, well under the 64KB
  fetch-keepalive cap). Validated by a new passthrough class keyed on
  `kind === "page-load"` AND payload presence (older clients → section omitted, never
  faked). One slow visit = one trace with the client evidence inside.
- **D6 — Vocabulary.** Final kinds: `"boot"` (server), `"page-load"` / `"element"`
  (client — what `handle-client-slow-op.ts:27` already mints). Fix
  `trigger-meta.ts`, which tints the never-minted `"client-page-load"`/`"client-element"`.
- **D7 — Non-goals.** boot-profile store/pane/permalinks stay (always-on deep-dive; the
  trace engine only captures *slow* incidents). No stitching browser + server boot into
  one trace row (Timeline wall-clock adjacency suffices). `boot.jsonl` not replaced or
  extended. No trace on fast boots.

## Implementation steps

### Step 1 — Trace class `plugins/debug/plugins/trace/plugins/boot/` (new; mirror `stall` byte-for-byte)

- `core/section.ts` — `BootSectionSchema`:
  `{ wallStartMs (epoch ms = Math.round(performance.timeOrigin) — boot-events' pairing
  key), totalDurationMs, spans: [{id, phase, plugin?, label, startMs, durationMs,
  physFootprintStartMb?, physFootprintEndMb?}] (mirrors server-core Span,
  profiler.ts:18-29), memoryCheckpoints: [{label, atMs, physFootprintMb, heapUsedMb}],
  gateway?: {spawnRequestedAt, spawnedAt, readyObservedAt, escalated, respondedHTTP,
  demoted} }`. Header comment: single source shared by producer/validator/lane; all
  offsets relative to `wallStartMs` — the section renders on its **own clock axis**,
  never the trace window's (engine clock-domain rule).
- `core/index.ts` — re-exports (stall shape).
- `server/internal/class.ts` — passthrough:
  `ctx.trigger.kind === "boot" ? (ctx.trigger.detail as BootSection) : undefined`;
  `defineTraceEventClass({ id: "boot", schema: BootSectionSchema, captureAtTrip })`.
- `server/internal/class.test.ts` — bun:test, copy stall's.
- `server/index.ts` — `contributions: [bootClass.contribution]`.
- `web/components/boot-lane.tsx` — self-contained card (own `GanttContainer`, the
  stall-card shape): phase-grouped bars via `GanttContainer` + `MultiSpanLane` from
  `@plugins/debug/plugins/profiling/web`; gateway-wait strip when present; checkpoints
  as labels; bar clicks → `TraceLaneProps.onSelect` `{title, fields}`.
- `web/index.ts` — `Trace.Lane({ match: "boot", component: BootLane })`. (The section
  renders via `GenericEventLane` even without this; the lane is polish and can trail.)
- `package.json`, `CLAUDE.md`.

### Step 2 — Producer `plugins/debug/plugins/boot-monitor/` (new; job copies boot-budget's `monitor-job.ts`)

- `core/config.ts` — `defineConfig({ name: "boot-monitor", fields: { enabled:
  boolField(true), totalBootBudgetMs: intField(10000) } })`; `core/index.ts`.
- `server/internal/gateway-report.ts` — zod schema (non-strict, skew-tolerant) +
  `defineEndpoint("POST /api/boot/gateway-report")` + `implement()` storing into a
  module-level box; exported getter. No auth — same trust surface as
  `/api/health/ready` (gateway dials the unix socket directly).
- `server/internal/monitor-job.ts` — `defineJob({ name: "debug.boot-monitor",
  dedup: "singleton", schedule: { cron: "* * * * *", perWorktree: true },
  maxAttempts: 3 })`. Per run: config gate → `getProfilingData()` → **skip unless a
  `drainWarmups` span exists** → module-level `minted` boolean (per-boot dedup) →
  build `BootSection` (+ gateway box if set) → if `totalDurationMs > totalBootBudgetMs`:
  `const trace = captureTrace({kind: "boot", label: "server-boot", durationMs,
  thresholdMs, detail: section})` then `await recordSlowOp({operationKind: "boot",
  operation: "server-boot", durationMs, thresholdMs, source: "server-boot-monitor",
  caller: null, traceId: trace?.id})` — evidence-first, the documented contract at
  `record-slow-op.ts:191-195`. Set `minted` either way.
- `server/index.ts` — job + endpoint + `ConfigV2.Register`; `web/index.ts` —
  `ConfigV2.WebRegister` only. **No new report kind** — flows through the existing
  `"slow-op"` kind, KindView, and trace deep-link.
- Modified: `plugins/reports/core/sources.ts` (+ `"server-boot-monitor"`);
  `plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts:31` (widen
  `Extract`). **boot-budget untouched.**

### Step 3 — Gateway (Go; `gateway/worktree.go` only)

- `bootStats` struct; stamp `spawnRequestedAt` before `startBackend`, `spawnedAt`
  after, `readyObservedAt` after `awaitBackendReady`; have `awaitBackendReady`
  (:977-985) surface `escalated` / `respondedHTTP` (its onEscalate closure already
  receives `respondedHTTP`).
- `postBootReport(socketPath, stats)` — unix-dial client (copy `waitReady`'s
  transport, 2s timeout), POST JSON; error/non-2xx → `slog.Warn`, 404 → `slog.Info`
  (older backend, tolerated skew). Never touches the state machine.
- `go postBootReport(...)` in both success paths immediately AFTER the proxy swap
  (`Ensure` ~:365, `Restart` ~:452) so it can never delay readiness.
- **Rollout:** code lands in this worktree/push; the running gateway keeps its old
  binary until the user runs the gateway recompile+restart (`./equin start`,
  explicitly user-gated). The TS side is fully functional standalone — `section.gateway`
  is simply absent until then.

### Step 4 — Client boot `plugins/debug/plugins/trace/plugins/client-boot/` (new) + additive slow-ops edits

- `core/section.ts` — `ClientBootSectionSchema` mirroring `BootTrace`
  (`spans, navigation, paint, firstCommitMs, longTasks, capturedAt`; typed against
  `@plugins/primitives/plugins/perfs/plugins/boot-trace/core`) with `assets` capped +
  `assetRollup {count, transferSize, decodedBodySize, droppedCount}`; plus the pure
  `toClientBootSection(trace, maxAssets = 20)` so builder/validator/lane single-source
  the trim. `core/section.test.ts` (bun:test).
- `server/internal/class.ts` — `ctx.trigger.kind === "page-load" ?
  (detail as {clientBoot?}).clientBoot : undefined`;
  `defineTraceEventClass({ id: "client-boot", ... })`; `server/index.ts`.
- `web/components/client-boot-lane.tsx` — card embedding **`BootProfileGantt`** (a pure
  function of a `BootTrace` prop) reused from boot-profile; the section reassembles a
  structurally-compatible `BootTrace` (trimmed assets render fewer rows; rollup as
  caption). `web/index.ts` — `Trace.Lane({ match: "client-boot" })`.
- Modified:
  - `plugins/debug/plugins/boot-profile/web/index.ts` — add
    `export { BootProfileGantt } from "./components/boot-profile-gantt"` (own-internal
    re-export, barrel-legal; verified currently not exported).
  - `plugins/debug/plugins/slow-ops/shared/endpoints.ts` — `clientBoot:
    ClientBootSectionSchema.optional()` (no import cycle: slow-ops → client-boot/core;
    client-boot never imports slow-ops).
  - `plugins/debug/plugins/slow-ops/web/components/slow-op-collector.tsx` — page-load
    branch (:21-46) attaches `toClientBootSection(getBootTrace())`; `keepalive: true`
    unchanged.
  - `plugins/debug/plugins/slow-ops/server/internal/handle-client-slow-op.ts` — add
    `clientBoot: body.clientBoot` to the existing `detail` (:31-35). `recordSlowOp`
    never sees it.

### Step 5 — Vocabulary polish

- `plugins/debug/plugins/trace/plugins/pane/web/internal/trigger-meta.ts`:
  `"client-element"` → `"element"`, `"client-page-load"` → `"page-load"`, add
  `boot: "warning"`. Optional trailing: `Trace.TriggerSummary({ match: "boot" })`
  (generic fallback already covers it).

### Step 6 — Build + docs

- `./equin build` regenerates registries for the 3 new plugins (never hand-edit
  generated roots).
- Update `plugins/debug/plugins/trace/CLAUDE.md` umbrella prose (boot + client-boot as
  trigger-owned classes beside stall).
- **Migrations: none** — operationKind/trigger kinds are open strings, sections live in
  the `snapshot` jsonb, gateway data is in-memory; only two new config registrations.

**Sequencing:** 1 → 2 → 4 → 5 → 3 → 6. Steps 1+2 and step 4 are independent; 3 depends
on 2's endpoint.

## Reused functions / primitives

`getProfilingData` (server-core/core), `captureTrace` + `defineTraceEventClass`
(trace/engine/server), `recordSlowOp` (slow-ops), `defineJob` (infra/jobs),
`defineEndpoint`/`implement` (infra/endpoints), `getConfig`/`ConfigV2.Register`
(config_v2), `getBootTrace` (perfs/boot-trace web), `GanttContainer`/`MultiSpanLane`
(debug/profiling web), `BootProfileGantt` (boot-profile, newly exported),
`Trace.Lane`/`Trace.TriggerSummary` (trace/engine web), gateway `waitReady` transport
pattern (Go).

## Verification

1. **Server boot:** build → set `boot-monitor.totalBootBudgetMs = 0` (Settings →
   Config) → restart the worktree backend → wait ≤1 min past drainWarmups →
   `query_db`: `slow_ops` row `operation_kind='boot'`, `traces` row
   `trigger_kind='boot'`; Debug → Slow Events shows the boot section (generic JSON
   lane pre-polish, custom Gantt lane after Step 1's web part); Reports bell has the
   slow-op with the View-trace chip.
2. **Gateway (without recompiling):** right after a restart, before the minute tick:
   `curl --unix-socket ~/.singularity/sockets/<wt>.sock -X POST
   http://backend/api/boot/gateway-report -d '{...}'` → next mint's section contains
   `gateway`. Full integration after the user-approved gateway restart.
3. **Client:** set `slow-op.pageLoadMs = 0` → reload → `page-load` slow-op + trace with
   `events["client-boot"]` → lane renders the Gantt; confirm beacon body < 64KB in the
   network tab on main (worst-case asset count).
4. **Unit:** `bun test plugins/debug/plugins/trace/plugins/boot` and
   `bun test plugins/debug/plugins/trace/plugins/client-boot`.
5. **Regression:** `./equin check`; boot-budget still files per-span reports
   (set a phase budget to 0, restart, check Reports).
