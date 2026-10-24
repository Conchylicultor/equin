# Interactive lane under load — context report + fix direction

**Status:** investigation complete, fix to be planned/implemented (this doc is the handoff).
**Goal of the fix:** the app must stay responsive under arbitrary host/CPU load. Reducing the
load itself (build admission, type-check budgets) is **explicitly out of scope** — the user
deferred it. The target property: *a human-blocking request's latency must never be a
function of background queue depth.*

---

## 1. The incidents (what the user experienced)

On 2026-07-09, twice (≈11:07 and ≈14:25), the main app (`singularity.localhost:9000`) became
unusable for minutes at a time:

- Page refresh took forever; most panes eventually rendered, but the **agent conversation
  pane showed "Loading…" for ~2–5 minutes** while everything else looked fine.
- Launching a conversation spun for ~5 minutes.
- "Apps queries take forever."

Meanwhile the Mac itself stayed smooth (browser, editor fine).

## 2. Root-cause chain (each link measured)

Full forensics below in §6; the chain:

1. **Trigger (out of scope for this fix):** 4–5 agent `./equin build` runs overlapped;
   each spawns up to 8 type-check workers (`min(cpus−1, 0.5·totalmem/2.7 GB)` — a per-process
   formula that assumes it is alone on the host). ~18–40 heavy processes → host load 50–63 on
   18 cores.
2. **Loop lag:** main backend event-loop lag rises with host load. Measured dose–response
   over ~20 h of `health.jsonl` × `health-host.jsonl` (7,266 samples):
   load <24 → ~1 ms p50; 32–40 → 27 ms; 40–48 → 107 ms; 48–56 → **~1,050 ms p50**.
   (QoS boost covers only the main thread; GC helpers unboosted; page faults block synchronously.)
3. **Lease inflation:** a DB transaction holds its pooled connection across every `await`
   continuation. At ~1 s lag, a 3-await transaction holds ~3 s instead of ~10 ms (~100–500×).
   Confirmed live: `pg_stat_activity` showed 5 "idle in transaction" sessions and only 2–4
   active queries while the app-side pool was 16/16 held. **Postgres itself was idle** — the
   collapse is entirely in the JS orchestration layer.
4. **Pool exhaustion → FIFO collapse:** background demand (flush cascade recomputes, jobs,
   report writes) does not back off, so pool utilization crosses 1 and the queue grows
   unboundedly. Measured at trip instant: `db-pool 16/16, 339 queued`; morning variant:
   `read-admit 6/6, 1,377 queued`. Victims' latency = queue depth ÷ throughput → minutes:
   `sub jsonl-events` 124 s (119.9 s of it `db-acquire` wait), `POST /api/conversations/:id/viewed`
   122 s, `job mail.sync-tick` 420 s, `flush flushNotifies` open 223–636 s, point-SELECTs
   (`… where id=$1 limit 1`) at 2.4 s.
5. **Self-amplification:** slow-op/report writes about the slowness are themselves DB writes
   (caught live: 3 concurrent `INSERT INTO slow_ops` blocked on each other's
   `Lock:transactionid`; report fingerprint counts in the thousands).

**Why the conversation pane specifically (differential symptom):** boot-critical resources
(tasks, attempts, config, build history) hydrate from the persisted live-state snapshot
(`database/live-state-snapshot`) without running loaders — that's why they rendered. The
conversation transcript (`jsonl-events`, keyed per conversation) cannot be pre-snapshotted, so
it is the one pane that must run a **live loader through the congested gates**. The user's
symptom is literally "snapshot-hydrated vs live-loaded".

## 3. Why the existing protection didn't hold

The right design already half-exists in `plugins/database/server/internal/client.ts`:

- `POOL_MAX = 16`, `RESERVED_INTERACTIVE = 6`: of 16 connections, 6 are meant to stay free
  for interactive work; loader/cascade queries route through `loaderDbGate` (10 slots).
- The gate classifies by `currentCallerKind()` (runtime-profiler ambient context, read
  synchronously before any await): kinds `"loader" | "cascade"` → gated; everything else
  (http, job, context-less) → ungated (`client.ts:219–231`).

Three gaps defeated it:

- **Gap A — origin blindness.** Inside a resource load, `currentCallerKind()` is `"loader"`
  regardless of *why* the load runs. A `sub`-ack initial load (a human just opened/refreshed a
  pane — `wrapOrigin("sub", …)`) and a cascade recompute (`wrapOrigin("push", …)`, machine
  work) are the same class at the gate. So on refresh, the user's cold loads queue FIFO
  behind hundreds of cascade recomputes. The runtime *already stamps the origin* (the
  `sub`/`push` entry spans exist in every trace); the gate just never consults it.
- **Gap B — the transaction bypass.** `db.transaction()` (drizzle) uses `pool.connect()`
  directly and bypasses both the wrapper and the reservation (documented in
  `plugins/database/CLAUDE.md`). Under lag, inflated transactions eat all 16 connections
  including the reserved 6. This is what killed the afternoon incident.
- **Gap C — jobs are ungated.** A `"job"`-kind query (graphile jobs: mail sync, sweeps…)
  runs ungated against the reserved capacity. `mail.sync-tick` held/waited on connections for
  7 minutes during the incident. Jobs are background by nature and should be in the
  background lane. (Careful: context-less queries also include **migrations/boot** — those
  must stay ungated.)

Related runtime facts:

- `readLoadGate` / `READ_LOAD_CONCURRENCY = 6` (`resource-runtime/core/runtime.ts:906,931`)
  bounds cold read-loads (sub-ack + HTTP GET fallback). Cascade is deliberately NOT gated
  there. In the morning incident it wedged only because its 6 holders were stuck at the
  layers below — fix the layers below and this gate likely stops wedging; consider
  priority-ordering later, not first.
- The flush cycle (`flushNotifies`, `runtime.ts:1654`) is a single re-draining mutex walking
  the DAG level-parallel; its loaders/cascade reads are the main background demand source.
- `flush`/`push`-origin loads are deliberately not read-admit-gated but ARE
  `loaderDbGate`-gated per query.

## 4. The fix (direction, not a final design — planner owns the details)

**One sentence:** partition every shared DB-capacity layer by *origin class* — "human-blocking"
(`sub`-ack loads, HTTP request/mutation handlers, boot-snapshot) vs "background" (`push`/cascade
recomputes, jobs, transactions from background origins) — so the reserved-interactive floor is
structurally unreachable by background work, no matter how slow or numerous it gets.

This is the standard industry pattern (bulkheads / request-criticality classes / Google RPC
criticality; browser `scheduler.postTask` priorities; SWR). The accepted trade: under
overload, **pull stays fast, push goes stale** — you always get current truth quickly when you
ask; already-open views may receive pushed updates late. Background lag is bounded-harm
(coalescing means a late recompute computes *current* truth).

Concrete pieces the planner should work out:

1. **Origin propagation.** Expose the *origin* kind from the recorder's ambient context —
   e.g. `currentOriginKind()` returning the outermost/nearest origin entry kind
   (`"sub" | "http" | "push" | "job" | …`), or stamp an explicit `origin` field in
   `wrapOrigin`. Must be readable synchronously (same constraint as `currentCallerKind`,
   `recorder.ts:1004`). Both the pool wrapper and a transaction gate will consult it.
2. **Pool wrapper partition** (`client.ts` `installQueryWrapper`): loader/cascade queries
   under a **background** origin → `loaderDbGate` (as today). Loader queries under a **sub**
   origin → interactive lane (ungated, like http today — or a generous sub-slice; planner
   decides). `"job"`-kind → background gate. Context-less (migrations/boot/pollers) → keep
   ungated (boot must never deadlock on a gate).
3. **Gate transactions** (Gap B): wrap the path drizzle transactions take (`pool.connect()`
   for the dedicated client) with the same origin classification: background-origin
   transactions acquire a bounded slice **inside** the background allotment (shared with
   `loaderDbGate` or a sub-slice — planner decides; total background hold must never exceed
   `POOL_MAX − RESERVED_INTERACTIVE`). Interactive-origin transactions (HTTP mutations) may
   use the floor. Register a gate gauge for the new gate (`registerGateGauge`) so it shows in
   traces automatically.
4. **Hold-time bound (supporting lint):** an ESLint rule in the repo's `promise-safety`
   pattern: inside a `db.transaction(async (tx) => …)` callback, every `await` must be a
   `tx.*` call — no `fetch`, no gate acquires, no fs. Caps hold at ~#statements × lag and
   prevents hold-and-wait deadlock shapes. (~15 existing `.transaction(` call sites to audit;
   `rg -n "\.transaction\(" plugins/ --glob '!*.test.ts'`.)
5. **Do not** touch `read-admit` sizing or priority in the first pass; re-measure after 1–4.

### Expected behavior after the fix (the acceptance property)

During a full incident (host load 60, loop lag ~1 s, cascade queue hundreds deep):

- Page refresh: boot snapshot + ~10 `sub` loads ride the interactive lane → all panes live in
  seconds (bounded by lag quanta × their own hops), **independent of background queue depth**.
- Conversation pane (`sub jsonl-events`): seconds, not minutes — same reason.
- Point mutations (`POST …/viewed`): ~2–3 s worst case.
- Background: flush cascade, mail sync, report writes crawl and queue among themselves;
  open views go stale by tens of seconds; nothing user-blocking waits behind them.
- Honest residual: per-await lag quanta remain (seconds at extreme load, not ms) — shrinking
  the *quantum* (off-thread heavy work / load control / process split) is explicitly out of
  scope here.

## 5. Verification plan

- **T1 — synthetic host load, no agents:** ~30 `taskpolicy -b` busy-loops to push load past
  50. Drive background churn with the existing synthetic emitter
  (`debug/live-state-churn/emit` — Debug → Live-State Emit or `window.__liveStateEmit`).
  Measure before/after fix: (a) `curl` point-endpoint latency, (b) cold `sub` latency on a
  non-boot-critical resource (open a conversation), (c) `db-pool` / gate gauges via a manual
  trace (`POST /api/debug/trace/test-trigger`, then read the `traces` row **via SQL** — the
  HTTP read path starves during incidents; that was observed live).
- **Invariant tests:** the DB-gate behavior is testable at the `client.ts` seam; the runtime
  has a DB-free harness (`resource-runtime/core/test-support.ts`) and a DB-backed fixture
  (`database/db-test-fixture`) for origin-propagation tests.
- **Real-world:** next stacked-build pile-up (they recur naturally), compare `health.jsonl`
  loop-lag + trace waits. The dose–response method: bucket `eventLoopP50Ms` by
  `health-host.jsonl` `loadAvg1`.

## 6. Forensic appendix (evidence pointers)

- **Traces (durable, 7-day TTL, `traces` table):** morning incident trip
  `d9fc1130-c4f6-4b30-bf16-8f1e91e2cf2d` (`sub conversations-active` 270 s; waits
  `read-admit: 269,358 ms`; gates `read-admit 6/6 q=1377`, `db-pool 16/16 q=50`; 600 spans in
  flight; `flushNotifies` open 636 s with waits `db-acquire 285 s / loader-acquire 344 s`).
  Afternoon: `05541a90-3e93-4684-9638-9055b712425a` (`sub jsonl-events` 124 s, `db-acquire`
  119.9 s; `db-pool 16/16 q=339`, other gates near-empty; pg 4 active backends only).
- **Health series:** `~/.singularity/worktrees/singularity/logs/health.jsonl` (+
  `health-host.jsonl` for loadAvg/swap). Readable from disk even when the backend is wedged.
- **Live DB state during incident:** `pg_stat_activity` — "idle in transaction" +
  `Lock:transactionid` on concurrent `slow_ops` inserts.
- **Key code:** `plugins/database/server/internal/client.ts` (POOL_MAX/RESERVED_INTERACTIVE/
  loaderDbGate/`installQueryWrapper`/callerKind gating, lines ~37–71 and ~210–232);
  `plugins/framework/plugins/resource-runtime/core/runtime.ts` (readLoadGate ~906–932,
  flushNotifies ~1654, wrapOrigin hooks); `plugins/infra/plugins/runtime-profiler/core/recorder.ts`
  (`currentCallerKind` ~1004, ambient context).
- **Prior art in-repo:** `research/2026-06-19-global-live-state-unified-read-path-v2.md`
  (Task 2 — the existing gate design), `research/2026-06-15-global-live-state-cascade-contention.md`,
  `research/2026-06-19-global-wait-attribution-instrumentation.md`,
  `research/2026-07-07-global-background-work-priority-isolation.md` (OS-level priority; this
  fix is the same idea one layer up).

## 7. Deferred / related (do NOT fold into this fix)

- **Build/type-check host-wide admission** (the incident *trigger*): per-process worker
  budget assumes solo host; the CLI build pool (`cli/bin/host-semaphore.ts`, cpus/4 slots,
  main exempt) bounds builds, not workers → 4–5 × 8 workers. Fix separately via
  `packages/host-semaphore` at worker granularity. Deferred by explicit user decision.
- **Gate-saturation monitor** (detection): health sampler already ticks 10 s and reads one
  gate; extend to all gate gauges, trip on queue depth/age, file a report + `captureTrace()`.
  Lesson from the incident: the alert path must not traverse the starved DB pool.
- **Process split** (physical bulkhead — cascade/jobs/sync in a worker process): the
  industry end-state, real project (flush shares in-memory registry/snapshots/DAG with the
  subscription path). Only consider after measuring the lane partition.
- **PgBouncer interaction** (unverified): transaction-mode, `default_pool_size = 16` per
  DB/user shared by ALL backends hitting the `singularity` DB — worth ruling out as a hidden
  serialization layer while at it.
