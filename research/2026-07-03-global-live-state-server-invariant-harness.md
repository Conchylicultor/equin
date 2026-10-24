# Live-State Invariant Harness — Server Half (Track 3a)

> Status: design (plan phase). Implements **Track 3a** of
> [`2026-07-02-global-comms-structural-fixes.md`](./2026-07-02-global-comms-structural-fixes.md).
> Companion follow-up (client half) is Track 3b.

## Context

The server resource runtime
(`plugins/framework/plugins/resource-runtime/core/runtime.ts`, 2400 lines) is
the single load-bearing implementation behind both per-worktree and central
live-state channels. Its hardest correctness invariants — the ones that make
scoped recompute, keyed delta-sync, and L2 cold-boot materialization safe — are
today verified only by manual checks or the prose of research docs. **Track 3a
must land before the A1 query-resource migrations touch the load-bearing
cascade** (Track 1 M4/M5): the harness is the protection those migrations lean
on.

`runtime.test.ts` (997 lines) already proves the fake-injection pattern —
`createResourceRuntime()` with a fake `ws.send`, a `controllable()` loader, and
a `feedHarness(readSetMap)` that drives `applyDbChange`. It covers level-parallel
flush, cascade ordering, version monotonicity, reentrancy, ETag revalidation,
`authorize`, and a solid slice of the scoped-vs-FULL routing table. It is
**missing** the specific invariants Track 3a enumerates:

1. **H5** — the notify-vs-fresh-sub race. `research/2026-04-15-global-sse-lifecycle-mental-model-v3.md`
   §9 explicitly prescribes "test by racing a `notify()` against a fresh `sub`
   in a unit test" — that test does not exist.
2. **Over-replay idempotence** — replaying an already-reflected change is
   harmless (the L2 "over-replay harmless / under-replay impossible" invariant,
   `research/2026-06-22-global-live-state-l2-persisted-materialization.md` §2/§6),
   plus the **L2 persist-hook calling contract** (capture-before-load ordering,
   persist-on-success-only, persisted-FULL forcing).
3. **Scoped-vs-FULL routing gaps** — sticky-FULL `mergePending` absorption,
   empty-scoped-set no-op, scoped∪scoped union coalescing.

### Scope boundary (what the runtime seam can and cannot reach)

The `createResourceRuntime` seam covers the **cascade + hook-contract** half of
"catch-up" with zero DB dependency: `catch-up.ts`'s `replayChange()` ultimately
calls the same `applyDbChange` the live LISTEN consumer uses, so "over-replay is
harmless" reduces to "replay the same change twice → identical value → empty
keyed diff → no frame", which is directly testable. The L2 persist hooks
(`shouldPersist`/`captureWatermark`/`persistSnapshot`) are injected into
`createResourceRuntime({...})`, so their calling contract is fully fake-testable.

**Out of reach at this seam** (no injection point today — they import the `db`
singleton directly): the xmin-vs-changelog-floor **arithmetic** in
`plugins/database/plugins/live-state-snapshot/server/internal/catch-up.ts`, the
`persist.ts` SQL correctness, and `listener.ts`'s LISTEN/reconnect/`fullSweep`
behavior. These need either an embedded-Postgres fixture or a `db`-parametrization
refactor — **filed as a follow-up task**, deliberately NOT in this harness.

**M5 membership fuzz** (Track 3a's fourth bullet, `diffKeyedScopedMembership`)
is **deferred**: that function does not exist yet — it lands with A1 M5 (opt-in
scoped membership). The harness is structured so its fuzz drops into
`keyed-diff.test.ts` beside the existing property tests when M5 ships.

## Design

All work stays inside `plugins/framework/plugins/resource-runtime/core/` as
co-located `bun:test` pure-logic tests (no DOM, no `__tests__/` folder — per the
repo testing rules). The runtime is **read-only** in this task except for a
possible small, clearly-correct guard fix if H5c surfaces a real hazard (see
below); the deliverable is tests + a shared support module.

### 1. Shared test-support module — `core/test-support.ts`

A plain `.ts` (not `.test.ts`, so `bun test` never collects it as a suite; it
imports no `bun:test`). Extracts the harness currently duplicated inside
`runtime.test.ts` and adds two capabilities the new tests need:

- `createHarness(opts?: { readSet?; sockets?; ...ResourceRuntimeOptions })` —
  wraps `createResourceRuntime(opts)`, opens N fake sockets, records **full
  parsed frames** (not just `{seq,key,kind,version}` — the new tests assert on
  `value`/`upserts`/`deletes`/`order`/`etag`). Subscribe/unsub/`pushesFor`/`tick`
  helpers. Subsumes today's `harness()` + `feedHarness()` (a `readSet` option
  folds them into one).
- `controllable(initial)` — the existing controllable-loader (block/release/setValue).
- **`makeClientView(keyOf?)` — a faithful client simulator.** Applies frames with
  the *real* WS version guard (`apply iff msg.version > entry.version`, baseline
  `-1` = "nothing applied") mirrored from
  `plugins/primitives/plugins/live-state/web/notifications-client.ts:862`, and
  merges keyed deltas with logic mirrored from `mergeKeyedDelta`
  (`.../web/keyed-delta-merge.ts`) — reimplemented locally with a cross-ref
  comment (cross-plugin import is banned; resource-runtime must stay acyclic and
  cannot import live-state). Models: `sub-ack`/`update` → set value+version if
  newer; `delta` → version-gate then merge (no base ⇒ record "drift/resub");
  `invalidate` → mark stale (a test converges it via `handleResourceHttp`);
  `up-to-date` → adopt version, keep value. This makes "**converges to server
  truth**" assertions *real* rather than frame-shape proxies.
- `rng(seed)` — the mulberry32 PRNG (dedupe from `keyed-diff.test.ts`).

`runtime.test.ts` and `keyed-diff.test.ts` are refactored to import from
test-support (removes the current duplication; a clean DRY win the review would
otherwise flag).

### 2. `core/runtime-h5.test.ts` — notify-vs-fresh-sub race

- **H5a (push):** a `notify()` flushes while a fresh sub's loader is parked
  (`controllable`). Assert the client simulator converges to the **latest** loader
  output and the stale sub-ack is version-dropped (never applied over the newer
  push). Versions monotonic.
- **H5b:** reverse ordering (sub completes, then notify) → converges.
- **H5c (keyed — the deep one):** a fresh sub races a notify that ships a full
  `update`, then a **subsequent** notify must still produce a delta the client
  merges without drift, converging to truth. This exercises the sub-ack keyed
  **snapshot-seeding** path (`handleSub` unconditionally
  `entry.snapshots.set(pk, snapshotOf(value))` at `runtime.ts:1989`) against a
  concurrent higher-versioned push that already advanced the server snapshot.
  - **If H5c is green:** ship as-is.
  - **If H5c surfaces a divergence** (the sub-ack snapshot-seed clobbering a
    push-advanced snapshot → later diffs miss rows → client stale): this is a
    genuine hazard and exactly what the harness exists to catch. Do **not**
    weaken the test. Either (a) apply the small, clearly-correct guard in
    `handleSub` (seed only when it does not regress a newer snapshot) with a
    cross-ref comment, if the fix is obviously correct and low-risk; or (b) file
    a bug task with the exact interleaving + root cause + fix proposal and land
    the test as `test.skip`/`test.todo` linking that task (keeps the shared
    suite green while the hazard is tracked structurally). Decide empirically;
    surface it loudly in the wrap-up either way.
- **H5d (multi-socket):** a second socket subscribes mid-flush; the first
  socket loses no frame (the sub-race angle on decoupling).

### 3. `core/runtime-scoped-routing.test.ts` — routing-table gaps

Uses `withNotifyBatch` / paired `applyDbChange` calls to force same-flush
coalescing.

- **Sticky-FULL absorption:** scoped(ids) + FULL(null) for the same pk in one
  flush → the loader recomputes **FULL** (`ctx === undefined`). Assert **both**
  orders (scoped-then-FULL, FULL-then-scoped) — the `mergePending` null-absorption
  (`runtime.ts:1103-1107`).
- **scoped∪scoped union:** two scoped changes, same pk, same flush → the loader's
  `ctx.affectedIds` equals the **union** of ids.
- **Empty-scoped-set no-op:** a scoped cascade whose `affectedMap` returns `[]`
  → downstream gets an empty non-null set → `drainEntry` `continue`
  (`runtime.ts:1575`): **no version bump, no frame, no cascade**. Assert
  downstream version unchanged and zero pushes. (Distinct from the existing
  signature-gate test, which short-circuits at the edge via `relevant.size===0`.)

The already-covered routing cases (covered-origin scoping, edge suppression,
secondary-view FULL, signature relevance gate) are **not** duplicated — a header
comment cross-refs them in `runtime.test.ts`.

### 4. `core/runtime-catchup.test.ts` — over-replay idempotence + L2 hook contract

- **Over-replay idempotence (keyed):** apply the *same* UPDATE change twice
  (separate flushes). First ships a `delta`; the second recomputes an identical
  value → empty diff → `onPush({changed:false})`, **no second delta frame**.
  Client simulator state identical. This is the "over-replay is harmless"
  invariant that lets `runCatchUp` safely replay changelog rows.
- **`recomputeResource(key)`** (`runtime.ts:2376`, untested today) → routes one
  FULL feed notify to subscribers; assert exactly one FULL push.
- **L2 persist-hook contract** (fakes injected via `createHarness({shouldPersist,
  captureWatermark, persistSnapshot})`, recording into a shared call-log):
  - `captureWatermark` is called **before** the loader's first read (call-log
    order: `wm` precedes `load`).
  - `persistSnapshot` fires on loader **success** with the FULL value +
    watermark + tablesRead; **never** on loader failure.
  - A persisted entry with **zero subscribers** still recomputes FULL and
    persists (`needValue` forced — `runtime.ts:1588-1591`).
  - A persisted entry is forced to **FULL even on a scoped change** (loader gets
    `ctx === undefined`) — pins "never persist a scoped partial".
  - `persistSnapshot` throwing (and `captureWatermark` throwing) does **not**
    block the push/cascade — the subscriber still receives its frame.

### 5. Docs + follow-ups

- Point `research/2026-04-15-global-sse-lifecycle-mental-model-v3.md` §9's H5 row
  (and the scoped/L2 hazards) to these tests as the living source of truth
  (Track 3's "the H1–H7 manual-check section gets a pointer to the tests").
- Add a short "Invariant harness" note to
  `plugins/framework/plugins/resource-runtime/CLAUDE.md` (what it covers, the
  `test-support.ts` module, the seam boundary).
- **File follow-up task** (`add_task` MCP): DB-backed harness for
  `live-state-snapshot/catch-up.ts` + `persist.ts` xmin/changelog SQL and
  `change-feed/listener.ts` reconnect logic — via embedded-Postgres fixture or a
  `db`-parametrization refactor. Explicitly the out-of-seam half of "catch-up".
  **DONE** — landed via `db`-parametrization + a throwaway-DB fixture on the
  running cluster; see
  [`2026-07-03-database-live-state-db-backed-invariant-harness.md`](./2026-07-03-database-live-state-db-backed-invariant-harness.md).
- If H5c is filed rather than fixed: a second follow-up task for that hazard.

## Critical files

- **New:** `plugins/framework/plugins/resource-runtime/core/test-support.ts`,
  `.../core/runtime-h5.test.ts`, `.../core/runtime-scoped-routing.test.ts`,
  `.../core/runtime-catchup.test.ts`.
- **Refactor (imports only):** `.../core/runtime.test.ts`,
  `.../core/keyed-diff.test.ts`.
- **Read-only reference:** `.../core/runtime.ts` (the SUT; possibly one small
  guard in `handleSub` only if H5c warrants), `.../core/keyed-diff.ts`,
  `plugins/primitives/plugins/live-state/web/{notifications-client,keyed-delta-merge}.ts`
  (semantics the simulator mirrors).
- **Docs:** `research/2026-04-15-global-sse-lifecycle-mental-model-v3.md`,
  `plugins/framework/plugins/resource-runtime/CLAUDE.md`.

## Verification

- `bun test plugins/framework/plugins/resource-runtime` — all suites green
  (existing + 3 new files). Every new invariant maps to a named test.
- `./equin build` then `./equin check` — green (type-check picks up
  the new `.ts`; no schema/migration surface touched).
- The harness is DB-free and socket-free, so it runs in the pure `bun:test`
  runner with no Postgres — the whole point of the fake-injection seam.
