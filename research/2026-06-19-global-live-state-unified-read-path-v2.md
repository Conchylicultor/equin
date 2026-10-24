# Live-state: one unified read path — the clean end state

**Date:** 2026-06-19
**Category:** global (resource-runtime, server-core, database)
**Supersedes the fix section of:** [`research/2026-06-19-global-parallel-load-loader-contention.md`](./2026-06-19-global-parallel-load-loader-contention.md) (keep that doc for the *measured diagnosis*; this v2 is the end-state design).
**Builds on / retires parts of:** [`research/2026-06-15-global-live-state-cascade-contention.md`](./2026-06-15-global-live-state-cascade-contention.md).

## Context

App load is intermittently slow (up to ~1 min) under parallel-agent load, and the config page is consistently >4 s. The measured root cause (see the v1 doc) is not Postgres, CPU, or memory — it is **a stampede of independent per-resource loads all fighting for 16 DB connections**, with throttles bolted on in front of the stampede (debounce, a loader-body semaphore) and more proposed (single-flight, gate-class hints).

The user's direction: **stop accreting throttles.** Plan the longer clean end state with a *simple, self-contained, unified mental model and a single path that cannot be bypassed.* This doc is that design, split into shippable tasks.

## The mental model (the whole thing in three sentences)

> A **resource is a value that lives in server memory.** Reading it — by a new tab, a reconnect, the boot snapshot, or a curl — is a **memory read**; it never touches Postgres. The value is **recomputed only when something invalidates it**, exactly once, by the single code path that is the *only* thing allowed to run a loader and the *only* thing that holds a DB connection.

That's it. Two scarce things, each behind exactly one un-bypassable path:

| Scarce thing | The one path | Result |
|---|---|---|
| **The resource value** | `getResourceValue(key, params)` → read memory; refill (single-flight) only if stale | Reads can't stampede the DB; N tabs reloading = N memory reads, 0 queries |
| **DB connections (16)** | the wrapped `pool.query`, gated by caller-kind at checkout | Background refills can't starve interactive writes; nothing bypasses the gate |

Everything else (debounce, push/invalidate, keyed deltas) becomes a *property of these two paths*, not a separate mechanism.

## End-state architecture

### 1. The resource value is a read-through cache owned by the runtime

The runtime already owns the registry, `versions`, keyed `snapshots`, and `subCounts`/`onLastUnsubscribe` (`resource-runtime/core/runtime.ts`). Add the missing piece: the **current value** per `(key, params)`.

- **Read** (`getResourceValue`): return the cached value if present; otherwise refill once (single-flight) and cache it. This is the *single* read entry point — `handleSub`, `handleResourceHttp`, and `loadResourceByKey` all call it and nothing else.
- **Invalidate** (`notify`): mark the entry stale (and, if it has subscribers, refill + push). `notify` is already called by every mutation today — we reuse that discipline; we do not invent new invalidation.
- **Refill**: the *only* place `entry.loader` runs. Single-flight by construction (a stale entry has at most one refill in flight). Debounce (`debounceMs`, already present) becomes "coalesce invalidations before the refill fires" — its natural meaning.
- **Eviction**: global resources stay cached (always subscribed by the running app). Parametrized resources (per-conversation, per-path) cache while subscribed and drop on `onLastUnsubscribe` (refcount already exists) — bounded memory.

Consequence: the boot stampede is **structurally impossible**, not throttled. A cold backend pays *one* coalesced refill wave on first boot; forever after, loads are memory reads.

### 2. The connection pool is the one gate, enforced at checkout

Delete the loader-body semaphore (`server-core/core/resources.ts:98`). Move the gate to where the scarce resource actually is — `pool.query` in `database/server/internal/client.ts` — and gate by **caller kind** (read from the profiler's ambient entry context, which already attributes every DB span to its enclosing loader/http):

> Of the 16 connections, at most ~10 may be held by **background/loader** queries at once; the rest are reserved for **interactive** (mutation/HTTP) work.

In-memory loaders never call `pool.query`, so they're never gated (the config page is fixed for free, no hint). Git loaders hold a connection only for their one fast query, then release before subprocess work, so they can't starve DB loaders. No `gate: compute|db|heavy` taxonomy — the gate measures the real thing (held connections), so cost-class is irrelevant.

### 3. The single path cannot be bypassed (enforced, not just intended)

- The runtime exposes **only** `getResourceValue`; `timedLoad`/`entry.loader` become private to the refill path. No caller can run a loader directly.
- All worktree-pool access goes through the wrapped `pool.query`. The legitimate exceptions are small and stay documented: `awaitDbReady`/`warmPool` (boot readiness on the main pool) and `adminPool`/`openShortLivedClient` (separate pools for cross-DB inspection + fork — a *different* scarce set, intentionally outside this gate).
- Add a `./equin check` (or lint) that fails on new direct `pool.connect()`/`new Pool` against the worktree pool outside the sanctioned files — so the single path can't silently regrow bypasses. (Project principle: fix the class with a check, not the instance.)

## What this removes (complexity going down, not up)

- **Deleted:** the loader-body semaphore (Change 4 of the 2026-06-15 track); the per-loader fan-out in boot-snapshot; my proposed `gate`-class hint taxonomy (never built); the cold-pool / boot-herd warm-up special-casing.
- **Subsumed into the one path:** single-flight (a property of refill, not a primitive call site); push-vs-refill-per-subscriber (everyone reads the same cached value).
- **Kept, because it's a genuinely separate concern:** `debounceMs` (coalesce invalidations over time — not a contention band-aid); the `inflight` primitive (reused inside refill); endpoints `dedupe` (HTTP layer).

This is the modern sync-engine shape (Linear/Convex/RSC: compute once, hold in memory, fan out). Singularity already half-implements it via `push` mode — the end state just makes *every* access go through the cache, and makes the DB gate guard the one scarce resource.

## Tasks (each self-contained and independently shippable, in order)

**Task 1 — Unify the read path behind `getResourceValue` + single-flight.**
Collapse the three `timedLoad` call sites (`handleSub`, `handleResourceHttp`, `loadResourceByKey`) into one accessor; add `inflight` single-flight inside it; **exclude scoped (`ctx.affectedIds`) keyed-delta loads** from coalescing (correctness — see v1 doc §A). No cache yet; behavior identical except duplicate concurrent loads collapse. *Lowest risk, immediate relief, lays the one-read-path foundation.*
Files: `resource-runtime/core/runtime.ts`, `packages/inflight`.

**Task 2 — Move the gate to the connection; delete the loader semaphore.**
Add a `currentCallerKind()` accessor to `runtime-profiler` (thin — context already exists). In `client.ts`, gate `pool.query` so loader-kind queries cap at ~10/16. Remove the semaphore from `resources.ts`. *Fixes the config-page head-of-line blocking structurally; in-memory loaders stop waiting.*
Files: `database/server/internal/client.ts`, `framework/plugins/server-core/core/resources.ts`, `infra/plugins/runtime-profiler/core`.

**Task 3 — Make the resource value a real read-through cache (the end state).**
Add the per-`(key,params)` value cache to the runtime; `getResourceValue` reads memory and refills single-flight on stale; `notify` invalidates; parametrized entries evict on `onLastUnsubscribe`. Debounce reinterpreted as invalidation coalescing. *This is the load-bearing structural change — the stampede becomes impossible.*
Files: `resource-runtime/core/runtime.ts` (registry entry gains `value`/`stale`).

**Task 4 — Boot snapshot from cache.**
`GET /api/resources/boot-snapshot` serializes the cached values of boot-critical resources (one pass, zero connections when warm; one coalesced wave when cold). Retire the `Promise.allSettled` per-loader fan-out.
Files: `infra/plugins/boot-snapshot/server`.

**Task 5 — Make the single path un-bypassable (harden).**
Audit + route remaining worktree-pool direct connects; add the `./equin check`/lint that forbids new bypasses of the wrapped `pool.query` and of `getResourceValue`. Update `resource-runtime`/`database` CLAUDE.md with the two-path mental model.
Files: `framework/plugins/tooling/plugins/checks/...` (or a `lint/`), `database/CLAUDE.md`, `resource-runtime/CLAUDE.md`.

*(Independent, complementary — schedule anytime):* **bound concurrent DB forks** with a `host-semaphore` (the worst cross-worktree I/O spike on spawn storms; `database/plugins/admin/server/internal/fork.ts`). Not part of the read-path unification; file as its own task.

## Key invariants / correctness

- **Cache correctness rides on the existing notify-discipline.** A DB write that doesn't `notify()` already fails to update open tabs today; the cache makes that same discipline load-bearing for one more reader. No new invalidation surface — but Task 3 should add a dev-mode assertion / doc making the "mutate ⇒ notify" rule explicit.
- **Scoped keyed-delta loads never coalesce and never serve from a partial cache** (they return partial arrays). The cache holds only full values; deltas are computed from full-value transitions.
- **Memory is bounded:** global resources are few and small (KB); parametrized resources are subscription-scoped and evicted on last unsubscribe.
- **Reads must never block on the connection gate** — they read memory; only refills touch the gate, so an interactive write is never behind a read.

## Verification

- **Config repro:** reload `/settings/config/cd/…push-and-exit/config.jsonc` → values <500 ms consistently; under the 16-concurrent-boot-snapshot storm, `config-v2.conflict-paths` stays <50 ms (after Task 2 it bypasses the gate; after Task 3 it's a memory read).
- **Stampede gone:** after Task 3/4, a multi-tab reload + boot-snapshot shows **0 loader runs** for warm resources in `get_runtime_profile kind:"loader"` (memory reads), and `[acquire]`/`[loader-acquire]` max collapses.
- **Interactive isolation:** under a deliberate background-refill storm, a mutation (POST) latency stays flat (reserved connections) — `get_runtime_profile kind:"http"`.
- **No stale data:** isolated mutation → its resource updates promptly in an open tab; burst → one coalesced refill, correct final value; keyed delta-sync (attempts/tasks) still reconciles without torn snapshots.
- `./equin check` passes, and (Task 5) the new bypass check fails on a deliberately-added direct `pool.connect()`.
