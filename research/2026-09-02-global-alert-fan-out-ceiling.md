# A cross-key fan-out ceiling for alerts

## Context

On 2026-09-02, 15:40:30–15:40:54 local (13:40 UTC), main raised **422 slow-op
notifications in 24 seconds**, 148 of them inside one second. The trigger was a
90 s host duress episode (`decompressionsPerSec`) during which the
`/ws/notifications` socket dropped. On reconnect, ~210 per-conversation
`conversation-categories` resources and ~210 per-block `page-block-doc`
resources all re-settled past the 1000 ms element threshold together.

The user saw a wall of toasts and a bell with hundreds of rows, none of which
said anything the others didn't.

**Every guard on this path keys on the operation identity**
(`operationKind:operation`, which embeds the row/block id), so all 422 were
distinct and none of them engaged:

| Guard | Where | Axis |
|---|---|---|
| report fingerprint dedup (`ON CONFLICT`, `count+1`) | `plugins/reports/server/internal/record-report.ts` → `upsertReport` | per fingerprint |
| velocity throttle (20/min → skip the bell) | `plugins/reports/server/internal/velocity.ts` | per fingerprint |
| 60 s bell re-alert cooldown (`resurfaceAfterMs`) | `plugins/shell/plugins/notifications/server/internal/record-notification.ts` | per fingerprint |
| duress shed persist-first-N | `plugins/infra/plugins/duress/server/internal/shed-buffer.ts` | per cascade key |

**Nothing counts how many alerts are being raised in total, across keys.** The
burst is across keys; every guard is within a key. That hole is generic to the
reports engine, not specific to slow ops — any kind with an open fingerprint
space (slow-op, op-time, endpoint-errors, mutation-errors, crash) can storm the
same way.

It also **amplifies the stall it reports**: the client sends one HTTP POST per
slow element. The op-rate monitor recorded
`http POST /api/slow-ops/client — 43.2s/window across 438 calls (budget 30.0s)`
for that window, each call doing a DB transaction plus a report upsert plus a
notification insert — against the backend that was already the thing failing.

### What must not change

The per-key signal is correct and stays. `slow_ops` (Debug → Slow Ops) and the
durable traces keep **every** occurrence, with counts, `maxMs`, caller
attribution, the `notifications-transport` wait split, and contention
snapshots. Those writes all happen *before* the report path, so this change
cannot touch them.

### Why collapsing the report row is the right call, not just the bell

The 422 rows are consequences, and each one individually points at the wrong
suspect: an agent opening `element page-block-doc {"id":"b-17"} took 1412ms` is
led to investigate a block renderer that is fine — the exact mislabelling
`plugins/debug/plugins/slow-ops/CLAUDE.md` already warns about. The fact that
identifies the bug — *418 unrelated operations went slow inside 24 seconds* —
appears in none of the 422 rows and only exists when they are counted together.
One rollup row carries that fact and links to the per-key detail; 422 rows bury
it, and bury any unrelated report filed during the same window.

Two properties make this safe for kinds whose row is the only evidence (crash):

- The budget is spent by a **fingerprint newly alerting**, not by an
  occurrence. A fingerprint that already has a live alert this window keeps its
  row and its bell behaviour exactly as today — repeats are not fan-out.
- The budget **refills every window**. Collapse is temporary: anything
  persistent mints its own row within a minute. Only the simultaneous burst
  collapses.

## Design

Two independent changes. The first is the fix; the second stops the reporting
path from amplifying the incident.

### 1. A per-kind fan-out ceiling in the reports engine

`velocity.ts` is the per-fingerprint half of the throttle. This adds its
**cross-fingerprint twin, per kind** — the same shape
`plugins/debug/plugins/trace/plugins/engine/server/internal/rate-limit.ts`
already has for traces (`admitTrace`: a per-key cooldown *plus* one global
per-minute bucket). Traces have the global half; reports never did.

#### New: `plugins/reports/server/internal/fan-out.ts`

Pure core + thin timer wrapper, mirroring `createShedCore` / `createShedBuffer`
in `shed-buffer.ts` (deterministic bookkeeping with no clock/timer/config, so
it is directly `bun:test`-able).

```ts
export interface FanOutBudget {
  distinctPerWindow: number;
  windowMs: number;
}

export type AlertAdmission =
  | { alert: true }
  | { alert: false }; // folded into this kind's storm accumulator

export interface FanOutCore {
  admit(kind: string, fingerprint: string, message: string,
        now: number, budget: FanOutBudget): AlertAdmission;
  takeStorm(kind: string, now: number): StormSummary | null;
}
```

Per-kind state, all naturally bounded (the `alerted` set stops growing at the
budget; the roster is capped):

- `windowStartedAt`
- `alerted: Set<fingerprint>` — fingerprints that already hold an alert this window
- `roster: Map<fingerprint, { message: string; count: number }>` — collapsed keys
- `rosterTruncated`, `occurrences`

`admit` logic:

1. Roll the window when `now - windowStartedAt > windowMs` (clears `alerted`).
2. `alerted.has(fp)` → `{ alert: true }`. **Repeats are not fan-out** — the row,
   the count, and the 60 s bell cooldown behave exactly as today.
3. `alerted.size < budget.distinctPerWindow` → add, `{ alert: true }`.
4. Otherwise → fold into `roster` (bounded; the tail only bumps
   `rosterTruncated` / `occurrences`, mirroring the shed buffer's
   `byCascade` + `dropped` accounting) → `{ alert: false }`.

The wrapper arms a **one-shot** `setTimeout(windowMs)` on the first collapse —
never a poll, exactly `maybeArmFlush`'s pattern in `shed-buffer.ts`. On fire it
closes the window and hands the summary to the engine, which files one report.

#### `record-report.ts` — where the gate sits

Insert the gate **after** the duress shed gate and **before** the row upsert:

```
stamp occurredAt → spec lookup → schema.parse → fingerprint
  → duress shed gate                       (unchanged)
  → NEW: fan-out gate                      ← here
  → clamp + bumpWindowAndCheck + noise
  → upsertReport → bell notification
```

A collapsed occurrence writes **no `_reports` row and no notification**. Placing
it after the duress gate means duress-replayed items pass through it too, which
is correct: a replayed storm is still a storm, and the `duress-shed` summary
already accounts for the replay separately.

`RecordReportResult` becomes a discriminated union so "collapsed" cannot be
mistaken for "recorded, unlimited" (today the shed path already returns
`reportId: null, rateLimited: false`, which is not honest):

```ts
export type RecordReportResult =
  | { outcome: "recorded"; reportId: string; taskId: string | null; rateLimited: boolean }
  | { outcome: "shed" }
  | { outcome: "collapsed"; stormKind: string };
```

`ReportResultSchema` (`plugins/reports/shared/endpoints.ts`) becomes the
matching `z.discriminatedUnion`. No caller reads the result fields today
(`handle-report.ts` returns it verbatim as the HTTP response), so churn is
confined to the schema.

#### Per-kind budget, with no spelling for "off"

`ReportKindSpec.meta.fanOutPerWindow?: number` — a kind may **raise** its
ceiling; there is no way to remove one. Engine default comes from config, so a
new kind cannot forget to have one.

`fanOutExempt?: boolean` on `ReportKindSpec`, mirroring the existing
`duressExempt` flag and used for exactly one thing: the storm kind itself, so
the mechanism can never collapse its own accounting.

#### New config: `plugins/reports/core/config.ts`

The reports plugin has no `config_v2` descriptor today. Add one modelled on
`plugins/infra/plugins/duress/core/config.ts` (read per admit via `getConfig`,
so tuning is live):

| field | default | meaning |
|---|---|---|
| `fanOutPerWindow` | 20 | distinct fingerprints of one kind that may raise their own alert per window |
| `fanOutWindowMs` | 60_000 | the window, and the storm rollup's flush delay |
| `stormRosterMax` | 50 | collapsed fingerprints the rollup names inline |

Registered via `ConfigV2.Register` in `plugins/reports/server/index.ts` and
`ConfigV2.WebRegister` in `plugins/reports/web/index.ts`, so it appears in
Settings → Config for free.

### 2. New report kind: `report-storm`

New sub-plugin `plugins/debug/plugins/report-storm/`, mirroring
`plugins/debug/plugins/duress-shed/` byte-for-byte in shape (`core/kinds.ts`
schema + `server/internal/report-storm-kind.ts` + `web/components/…` for the
`Reports.KindView`). The engine names the kind string when it files the
rollup — the same precedent `record-report.ts` already sets for `duress-shed`.

Payload (`core/kinds.ts`):

```ts
export const ReportStormPayloadSchema = z.object({
  collapsedKind: z.string(),
  windowStartedAt: z.number(),
  windowEndedAt: z.number(),
  budget: z.number(),
  distinctFingerprints: z.number(),
  occurrences: z.number(),
  roster: z.array(z.object({
    fingerprint: z.string(), message: z.string(), count: z.number(),
  })),
  rosterTruncated: z.number(),
});
```

- **Fingerprint**: `report-storm:${collapsedKind}:${windowStartedAt}` — one row
  per (kind, window), exactly like `duress-shed`'s (buffer, episode). The 24 s
  incident yields **one** row; a ten-minute stall yields ten, each naming its
  own roster.
- **meta**: `tag: "[storm]"`, `notif: "Alert storm collapsed"`,
  `variant: "warning"`, `fanOutExempt: true`. No `notifCooldownMs` — each
  window is already its own row.
- **`renderTask`** describes the shape of the burst and points at Debug → Slow
  Ops (and the per-kind view) for the per-operation detail that was never lost.
- Add `"server-report-storm"` to `SERVER_REPORT_SOURCES` in
  `plugins/reports/core/sources.ts`.

What the incident would have produced instead of 422 rows:

```
[storm] slow-op: 418 operations raised 422 alerts in 24s (budget 20/min)
        top: element page-block-doc ×210, element conversation-categories ×208
        ↳ Debug → Slow Ops for per-operation detail
```

### 3. Batch the client beacon

`plugins/debug/plugins/slow-ops/` — stop sending one POST per slow element.

- **`shared/endpoints.ts`**: today's body becomes `SlowOpClientItemSchema`; the
  body becomes `{ items: z.array(item).min(1).max(MAX_CLIENT_SLOW_OP_ITEMS), dropped?: number }`.
  `MAX_CLIENT_SLOW_OP_ITEMS = 200` is exported from `core` so the client chunks
  to it (mirrors `MAX_EMIT_LINES` in `log-channels`). This is a breaking wire
  change; a stale tab's beacon 400s silently, which is correct for a
  `report: false` beacon.
- **New `web/internal/slow-op-queue.ts`**, mirroring
  `plugins/primitives/plugins/log-channels/web/client-log.ts`: a module-level
  buffer, a single trailing `setTimeout(250)` flush (a debounce, not a poll),
  a `MAX_QUEUED = 1000` cap that drops oldest and carries a `dropped` counter
  into the next batch, chunked `keepalive` POSTs, and a `pagehide` flush.
  Exports `enqueueSlowOp(item)`.
- **`web/components/slow-op-collector.tsx`**: both signals call
  `enqueueSlowOp(...)` instead of `fetchEndpoint(...)`. Nothing else changes —
  the thresholds, the cold-start attribution, and the "never suppress a slow
  settle" rule all stay.
- **`server/internal/handle-client-slow-op.ts`**: loop the items (per-item
  `captureTrace` — its own `admitTrace` limiter already bounds it) and hand the
  batch to `recordSlowOpBatch`. A non-zero `dropped` publishes one line to a
  new `defineLogSink({ id: "slow-ops" })`.

### 4. One transaction per batch in the slow-op funnel

`plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts` currently
opens one Postgres transaction per item. 210 commits during a stall is the
other half of the amplification.

- Split `upsertSlowOp` into `upsertSlowOpIn(tx, input, occurredAt, snapshot)`
  (the body) and the existing `upsertSlowOp(…, conn = db)` wrapper (which keeps
  the `conn.transaction`, so the DB-backed test suite is unaffected).
- Add `recordSlowOpBatch(inputs)`: stamp `occurredAt` per item, run the duress
  `admit` per item, then take **one** contention snapshot and open **one**
  `db.transaction` inside a single `runInBackgroundLane(() => runWithoutProfiling(…))`
  scope, calling `upsertSlowOpIn` per admitted item. Markers and
  `recordReport` still fire per item afterwards.
- `recordSlowOp(input)` becomes `recordSlowOpBatch([input])`, so the server-span
  path and the client path stay one funnel.

## Files

| File | Change |
|---|---|
| `plugins/reports/server/internal/fan-out.ts` | **new** — pure core + one-shot timer wrapper |
| `plugins/reports/server/internal/fan-out.test.ts` | **new** — budget spend, repeat pass-through, window roll, roster cap, exempt kind |
| `plugins/reports/server/internal/record-report.ts` | gate after the duress gate; file the rollup; union result |
| `plugins/reports/server/internal/report-kinds.ts` | `meta.fanOutPerWindow?`, `fanOutExempt?` |
| `plugins/reports/core/config.ts`, `core/index.ts` | **new** `reportsConfig` |
| `plugins/reports/core/sources.ts` | `"server-report-storm"` |
| `plugins/reports/shared/endpoints.ts` | `ReportResultSchema` → discriminated union |
| `plugins/reports/{server,web}/index.ts` | `ConfigV2.Register` / `WebRegister` |
| `plugins/debug/plugins/report-storm/**` | **new** sub-plugin (mirror `duress-shed`) |
| `plugins/debug/plugins/slow-ops/shared/endpoints.ts` | batched body |
| `plugins/debug/plugins/slow-ops/web/internal/slow-op-queue.ts` | **new** (mirror `client-log.ts`) |
| `plugins/debug/plugins/slow-ops/web/components/slow-op-collector.tsx` | enqueue instead of POST |
| `plugins/debug/plugins/slow-ops/server/internal/handle-client-slow-op.ts` | loop the batch |
| `plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts` | `recordSlowOpBatch`, `upsertSlowOpIn` |

No migration: the storm payload rides the existing `reports.data` jsonb.

## Verification

1. `./equin build` in the background; confirm `status: ok` in
   `~/.singularity/worktrees/<wt>/build-status.json`.
2. `./equin check` — `plugin-boundaries`, `plugins-doc-in-sync`,
   `type-check`, `migrations-in-sync`.
3. `./equin test plugins/reports plugins/debug/plugins/slow-ops` — the new
   pure-core suite plus the existing `record-slow-op.test.ts`.
4. **Force a storm.** In Settings → Config set `slow-op.elementMs` to `1` and
   `reports.fanOutPerWindow` to `5`, then load a conversation with many blocks.
   Expect, via `query_db`:
   - `slow_ops` — a row per resource, every one of them (nothing lost);
   - `reports where kind='slow-op'` — at most 5 new fingerprints in the window;
   - `reports where kind='report-storm'` — exactly one row, whose `data.roster`
     names the collapsed operations and whose `distinctFingerprints` matches the
     `slow_ops` row count minus 5;
   - `notifications` — one new row, and one toast on screen.
5. **Confirm collapse is temporary**: keep the page open a further minute and
   confirm a still-slow operation mints its own `slow-op` row in the next window.
6. **Confirm the beacon is batched**: in DevTools → Network, one
   `POST /api/slow-ops/client` per ~250 ms carrying many items, instead of one
   per element. Re-run the op-rate monitor window and confirm the
   `http POST /api/slow-ops/client` op-time trip no longer fires.
7. Restore `elementMs` and `fanOutPerWindow` to their defaults and confirm
   normal single-report behaviour returns.
