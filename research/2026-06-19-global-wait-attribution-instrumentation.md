# Wait-layer measurement + attribution in the profiler

**Date:** 2026-06-19
**Category:** global (runtime-profiler, resource-runtime, server-core, database, host-read-pool, slow-ops)
**Depends on / instruments the end state of:** [`research/2026-06-19-global-live-state-unified-read-path-v2.md`](./2026-06-19-global-live-state-unified-read-path-v2.md). The connection-gate move (Task 2) has **landed** (`loaderDbGate` lives in `database/server/internal/client.ts`; `[loader-acquire]`/`[heavy-read-acquire]` are emitted there). The read-through cache (Task 3) has **not** landed yet — this work is **last in the chain** and assumes the cache lands (cache hits charge nothing; refills carry the waits).
**Diagnosis it makes self-service:** [`research/2026-06-19-global-parallel-load-loader-contention.md`](./2026-06-19-global-parallel-load-loader-contention.md).

## Context

Queueing slowness is currently undiagnosable from the debug surfaces — both the config-page >4s and the edited-files 4032ms required manual reproduction to attribute, because the profiler hides where the time goes. Two concrete gaps:

1. **Wait spans aren't attributed to the resource + request that waited.** A loader span triggered by a WS subscription gets `parent: null` (no entry context is established in `handleSub`/`flushNotifies`), and the gate-wait lands in a single shared bucket (`db` kind, label `[loader-acquire]`) aggregated across *all* loaders. So a cheap loader that was head-of-line-blocked for 1.8s looks byte-identical to one that wasn't. You can see "loaders are waiting" in aggregate but not "the config page is slow because **its** load waited behind the gate."
2. **Heavy-loader waits are conflated with work.** A loader's `recordEntrySpan` measures wall time = wait + work. `edited-files` 4032ms could be mostly `[heavy-read-acquire]` lock-wait or mostly the git diff — the surfaces can't tell.

**Goal:** every wait layer separately measured AND attributed to the originating resource + request, so head-of-line blocking and lock-vs-work are diagnosable from `get_runtime_profile` / Debug → Slow Ops **without manual repro**.

## Approach (the load-bearing primitive: per-entry wait accumulation)

The information is lost at the wrong moment: each gate records a standalone `recordSpan("db", "[*-acquire]", waitMs)` whose aggregate is keyed by `(db, "[loader-acquire]")` — collapsing every loader's wait into one row. The per-loader split exists only buried in `byParent`, and the wait is **never subtracted from the loader's own span**, so work = total − wait is unreadable.

Fix: extend the ambient entry context so each gate **charges** its wait — keyed by layer name — to the innermost enclosing entry's own mutable accumulator. `recordEntrySpan`, on finish, emits the entry's total duration *plus* a `waits` breakdown by layer. Combine with establishing entry contexts at the WS-sub / push origins so loader spans are never `parent: null` and the originating request class is identified.

Two decisions taken (both the recommended option):
- **Request attribution = coarse origin kind.** Add `"sub"` and `"push"` to `SpanKind`; sub/push-driven loads run inside `recordEntrySpan(kind, resourceKey, …)`. The loader entry nests inside, so its `parent` becomes `{kind:"sub"|"push", label:resourceKey}` — never null. No new request-id infra; aggregates stay keyed by `(kind,label)`. The loader's single record then carries **resource** (`label`) + **request class** (`parent`) + **wait breakdown** (`waits`) + **work** (`total − Σwaits`) in one row.
- **Fold wait into the entry; drop the standalone gate spans.** Gates call a new `chargeWait(layer, ms)` instead of `recordSpan("db", "[*-acquire]", …)`. Context-less callers (jobs/pollers with no active entry) fall back to a standalone span so a wait is never silently lost.

## File-by-file plan

### 1. Recorder + context — `plugins/infra/plugins/runtime-profiler/core/recorder.ts`

Additive, backward-compatible type changes:
- `export type WaitBreakdown = Record<string, number>;` (layer → ms).
- `SlowSpan` and `Aggregate` each gain `waits?: WaitBreakdown` (entry spans that waited).
- `SpanKind` gains `"sub" | "push"`; update `KINDS` and the `aggregates`/`slowest` records to include `sub`/`push` empty maps.
- Internal ambient store becomes a mutable per-entry accumulator (keep public `SpanRef = {kind,label}` unchanged):
  ```ts
  export interface EntryContext { kind: SpanKind; label: string; waits: Map<string, number>; }
  ```
  Change the injected `SpanContextRuntime` generic from `SpanRef` to `EntryContext`. `recordSpan`/`currentCallerKind` keep reading `.kind`/`.label` off `current()` (an `EntryContext` is a structural superset of `SpanRef`), so `parent` building is identical.
- New exported helper:
  ```ts
  export function chargeWait(layer: string, ms: number): void {
    const cur = contextRuntime.current();
    if (cur) cur.waits.set(layer, (cur.waits.get(layer) ?? 0) + ms);
    else record("db", `[${layer}]`, ms, null); // context-less fallback — never lose a wait
  }
  ```
- `recordEntrySpan` builds a fresh `EntryContext` (own `waits` map per entry — nested entries don't share), runs `fn` under it, and on `finally` passes `ctx.waits` (materialized to an object, or `undefined` if empty) into `record(...)`.
- `record()` gains a 5th param `waits?: WaitBreakdown`: merge-sum per layer into the aggregate's `waits`, and attach `waits` to the pushed `SlowSpan` and the slowest-ring entry.
- `getRuntimeProfile()` passes `agg.waits` into the materialized `Aggregate`.

Note: ALS preserves object identity across awaits, so a gate awaited deep inside a loader charges the *same* entry's map — this is why per-entry accumulation works for free. A loader charges wait to **itself**, not its parent origin (wait is a property of the resource load; the parent link names the request). The gate calls `chargeWait` once → only the innermost `current()` is hit → no double-count.

### 2. Ambient install — `plugins/infra/plugins/runtime-profiler/server/internal/install.ts`

Change `AsyncLocalStorage<SpanRef>` → `AsyncLocalStorage<EntryContext>`. No other change.

### 3. Charge sites (replace standalone acquire spans)

- `plugins/database/server/internal/client.ts`: the loader gate becomes
  `loaderDbGate.run(runTimed, (waitMs) => chargeWait("loader-acquire", waitMs))`.
  Leave the per-query `[acquire]` (pool.connect wait) and `<sql text>` leaf spans untouched — those are real per-query measurements, not gate waits.
- `plugins/infra/plugins/host-read-pool/server/internal/pool.ts`: `pool.run(fn, (waitMs) => chargeWait("heavy-read-acquire", waitMs))`.

Both `onWait` callbacks already fire synchronously at slot acquisition with the ambient entry active — exactly when `chargeWait` needs `current()`.

### 4. Origin / request attribution — `plugins/framework/plugins/resource-runtime/core/runtime.ts`

`core` cannot import the profiler directly (it is shared with central-core). Follow the existing `wrapLoad` injection pattern: add an optional hook to `ResourceRuntimeOptions`:
```ts
wrapOrigin?: (kind: "sub" | "push", key: string, fn: () => Promise<unknown>) => Promise<unknown>;
```
Wrap the origin-triggered loads (fall back to the bare call when the hook is absent):
- `handleSub` — wrap the `getResourceValue(entry, params)` call with `opts.wrapOrigin?.("sub", key, …)`.
- `flushNotifies` — wrap its `getResourceValue(entry, params, ctx)` with `("push", entry.key, …)`; also wrap the keyed-reseed full reload with `("push", entry.key, …)`.

`flushNotifies` runs in a bare `queueMicrotask` (no ALS); wrapping in `recordEntrySpan` re-establishes a fresh ALS scope, so previously-`null` push-driven loader spans now get a parent **and** their waits charge correctly. This closes the parent:null gap for both sub and push origins.

### 5. Supply the hook — `plugins/framework/plugins/server-core/core/resources.ts`

Add to the `createResourceRuntime({ … })` call (it already imports `recordEntrySpan`):
```ts
wrapOrigin: (kind, key, fn) => recordEntrySpan(kind, key, fn),
```
central-core omits `wrapOrigin` exactly as it omits `wrapLoad` (identity passthrough).

### 6. SpanKind ripple (mechanical)

Adding `"sub"|"push"` touches every kind enumeration:
- `runtime-profiler/core/recorder.ts`: `KINDS`, `aggregates`, `slowest`.
- `debug/plugins/profiling/plugins/runtime/shared/endpoints.ts`: the `z.enum([...])` kind enums (two places) + the per-kind `byKind`.
- `debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`: `KINDS`, the `kind` enum param, the result shape.
- `debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx`: `RuntimeKind`, the enum options, the `tag(...)` calls.
- `debug/plugins/slow-ops/server/internal/install-slow-span.ts` (`thresholdFor`): route `sub`/`push` to `loaderMs` — **no new config fields**.

### 7. Surfacing — `get_runtime_profile` (MCP)

- `…/runtime/shared/endpoints.ts`: add `waits: z.record(z.string(), z.number()).optional()` to the aggregate and slow-span schemas.
- `…/runtime/server/internal/mcp-tools.ts`: emit `waits` per aggregate + slow-span row, plus a derived `workMs = round((totalMs − Σwaits)/count)`. Extend the description so the wait breakdown + work split is discoverable. This is what makes "config page slow because ITS load waited behind the gate" readable without repro.

### 8. Surfacing — durable slow-ops store + UI

- `debug/plugins/slow-ops/core/resources.ts`: add one field to `slowOpFields` (co-derives the `slow_ops` column **and** the wire schema in one edit):
  ```ts
  waits: jsonField<WaitBreakdown>({ schema: z.record(z.string(), z.number()), default: {} }),
  ```
  Migration regenerates on `./equin build`.
- `debug/plugins/slow-ops/server/internal/install-slow-span.ts`: pass `waits: span.waits` into `recordSlowOp`.
- `debug/plugins/slow-ops/server/internal/record-slow-op.ts`: add `waits?: WaitBreakdown` to `RecordSlowOpInput`; merge-sum per layer into the existing row's `waits` json inside the same transaction (mirror the existing `mergeCaller` helper with a `mergeWaits`).
- UI (one column each, minimal):
  - `…/runtime/web/components/runtime-section.tsx`: add a "Work / Wait" column rendering `workMs` with the per-layer wait breakdown beneath (reuse the inline `byParent` breakdown pattern).
  - `debug/plugins/slow-ops/plugins/pane/web/components/slow-ops-view.tsx`: add a "Wait" column showing the dominant layer + ms and computed work.

## Interaction with the read-through cache (Task 3, assumed landed)

- **Cache hit:** `getResourceValue` returns memory without entering `wrapLoad` → no loader span, no gate, no `chargeWait`. A hit is genuinely free (matches the v2 doc's "0 loader runs for warm resources").
- **Refill (single-flight) serving many coalesced reads:** the refill runs under **one** `wrapLoad` entry (the first caller's); gate waits charge to that one loader's `waits` map; coalesced followers attach to the inflight promise and never enter `wrapLoad`. Wait is charged once, to the resource, attributed to whichever origin (`sub`/`push`) won the inflight race. No double-charge, no smearing. Attributing one refill to the single winning origin is correct and desirable — the aggregate's `byParent` shows the real sub-vs-push mix over many samples; do not attempt multi-origin attribution (that is the request-id complexity we explicitly avoided).

## Ordering (each sub-step independently shippable)

1. Recorder primitive (`recorder.ts` + `install.ts`): `EntryContext`, `waits` types, `chargeWait`, `recordEntrySpan` emit, `record` merge. No behavior change yet.
2. Charge sites (`client.ts`, host-read-pool `pool.ts`): swap standalone acquire spans → `chargeWait`. Loader spans now carry `waits`.
3. SpanKind extension (`sub`/`push`) across the enumerations in step 6.
4. Origin hooks (`runtime.ts` `wrapOrigin` + wrap sites; `resources.ts` supplies the hook). Loader spans get non-null sub/push parents.
5. Surfacing — MCP + durable store + UI (steps 7–8). Run `./equin build` for the migration.

## Critical files

| Concern | File |
|---|---|
| Per-entry wait accumulation + types + `chargeWait` | `plugins/infra/plugins/runtime-profiler/core/recorder.ts` |
| ALS store type | `plugins/infra/plugins/runtime-profiler/server/internal/install.ts` |
| Connection-gate charge site | `plugins/database/server/internal/client.ts` |
| Host-read-pool charge site | `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` |
| Origin hook + wrap sites | `plugins/framework/plugins/resource-runtime/core/runtime.ts` |
| Supply `wrapOrigin` | `plugins/framework/plugins/server-core/core/resources.ts` |
| MCP output | `plugins/debug/plugins/profiling/plugins/runtime/{shared/endpoints.ts,server/internal/mcp-tools.ts}` |
| Runtime UI | `plugins/debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx` |
| Durable store + merge + UI | `plugins/debug/plugins/slow-ops/{core/resources.ts,server/internal/install-slow-span.ts,server/internal/record-slow-op.ts,plugins/pane/web/components/slow-ops-view.tsx}` |

## Verification

**Repro A — config page (head-of-line blocking + lock-vs-work):**
1. Reload `/settings/config/cd/…push-and-exit/config.jsonc`.
2. `get_runtime_profile kind:"loader"` → `config-v2.conflict-paths` row shows `parent:{kind:"sub", label:"config-v2.conflict-paths"}`, `waits:{loader-acquire: N}`, `workMs = total/count − N`. Pre-fix this row was `parent:null` with no wait info; the 1.8s now reads as e.g. `wait 1700 / work 100`.
3. With Task 3 landed: a second reload shows **no** `config-v2.conflict-paths` loader row (memory read) — confirms the cache-hit path charges nothing.

**Repro B — 16-concurrent boot-snapshot storm (gate saturation):**
1. Fire 16 concurrent boot-snapshot loads (parallel-agent boot, or the storm harness from the contention doc).
2. `get_runtime_profile kind:"loader"` → cheap in-memory loaders show `waits:{loader-acquire: high}`, `workMs ≈ 0` (head-of-line-blocked, not slow themselves); `edited-files` shows `waits:{heavy-read-acquire: X, loader-acquire: Y}` separated from `workMs` (the git diff) — lock-vs-work split.
3. `get_runtime_profile kind:"sub"` / `kind:"push"` → origin entries exist; cascade refills appear under `push`, user navigations under `sub`.
4. Debug → Slow Ops → `loader` rows carry the Wait column durably; a 4032ms `edited-files` row reads its wait-vs-work split surviving restart, **without manual repro**.

**Regression checks:**
- `db` aggregates keep `[acquire]` + `<sql text>`; the standalone `[loader-acquire]`/`[heavy-read-acquire]` rows no longer appear **except** under context-less callers (verify a poller-driven heavy read still records a fallback wait span).
- No more `parent:null` loader spans under sub/push load.
- central-core (no `wrapLoad`/`wrapOrigin`) still loads resources via identity passthrough.
- `./equin check` passes (boundaries, migrations-in-sync, doc-in-sync, type-check).
