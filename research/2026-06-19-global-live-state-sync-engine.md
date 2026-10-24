# Live-State → a true sync engine: the global vision

> **Category:** global (resource-runtime, server-core, database, infra)
> **Status:** design / research plan (no code yet)
> **Sibling (co-designed, must ship as one architecture):**
> [`2026-06-19-global-live-state-work-admission-model.md`](./2026-06-19-global-live-state-work-admission-model.md)
> (in worktree `att-1781872031-6620`).

## 1. Context

Live-state keeps the DB as source of truth and propagates values to clients (and,
after the read-through-cache work, a server-side cache) via manually-called
`notify()`. Two structural weaknesses keep getting worked around rather than
solved:

1. **Consistency rides on discipline, not guarantees.** Invalidation is hand-called
   after each mutation (~155 `notify()` sites, ~37 hand-drawn `dependsOn` edges). A
   skipped `notify()` silently serves stale state. The June read-through cache
   (`2026-06-19-global-live-state-unified-read-path-v2.md`) makes this *worse*: its
   own doc admits *"cache correctness rides on the existing notify-discipline"* — a
   missed update now **survives reloads** instead of self-healing.
2. **Cold loads recompute whole views from scratch (4–10 s+).** The in-memory cache
   removes *redundant* runs but is lost on restart, so every deploy pays the full
   cold recompute; and a single cold/invalidated recompute is still a full-list
   aggregation, a multi-table join, or a git subprocess fan-out.

The runtime is already far past "manual notify": it has a dependency DAG
(`dependsOn`/`map`/`affectedMap`), **Layer-2 scoped recompute** (`affectedIds` →
`WHERE id IN (…)`), keyed delta-sync, single-flight reads, and a caller-kind DB
gate. **What's missing is not mechanism — it's a *source of change* that can't be
forgotten, and a *cost per recompute* that isn't a full rebuild.** This doc owns
those two; the sibling work-admission doc owns *bounding the total work per unit
time*. Together they are the two halves of one sync engine (§3).

**Outcome wanted:** a missed update is *structurally impossible*, idle cost is
*provably ≈ 0*, and a recompute touches *only what changed* — as invariants the
runtime defends, behind an authoring API that **shrinks** rather than grows.

## 2. The mental model: Pull, and Push = Source → Scheduler

The live-state pipeline has two phases. The sibling doc nailed phase one and named
phase two; this doc splits phase two into the two things it actually contains.

```
            ┌─────────────────────────── PUSH ───────────────────────────┐
   a write  │  INTENT SOURCE                 INTENT SCHEDULER             │   PULL
  ───────►  │  (this doc)        ─intent─►   (work-admission doc)   ─────► │ ──────►
            │  read-set ∩ change-feed        admit·coalesce·bound·account │  getResourceValue
            │  → RecomputeIntent{Δ}          (scope/skip fed by the Δ)    │  flushNotifies
            └─────────────────────────────────────────────────────────────┘
```

- **Pull** — read a resource value, dedupe, deliver. *Done* (`getResourceValue` +
  single-flight; `flushNotifies`; keyed-delta wire).
- **Push / Intent Source (this doc)** — *what produces a recompute intent, and what
  delta it carries.* Today: hand-called `notify()` (forgettable) carrying a
  hand-passed `affectedIds` (the discipline problem). Target: DB-derived, automatic,
  delta-bearing.
- **Push / Intent Scheduler (work-admission doc)** — *admit / coalesce / scope /
  bound / account* the intents. Bounds the **sum** of work.

The scheduler can't *scope to the changed key* or *skip if unchanged* unless
something tells it **what changed** and **what each resource depends on**. That
something is this doc. **Mine is the source; theirs is the scheduler; they meet at
the intent.**

## 3. Relationship to the work-admission doc (the one co-design point)

Their scheduler keeps `notify` as the intent source, so on its own it does **not**
fix structural consistency (a *missed* notify is still stale) and its strongest
claim — *idle ≈ 0* — is unreachable while a forgettable hand-call is the trigger.
Two of its five levers are *fed by this doc*:

| Scheduler lever (their doc) | Fed by |
|---|---|
| admit — if subscribed | scheduler (refcount exists) — **theirs** |
| admit — **skip if inputs unchanged** | **this doc** (read-set ∩ change-feed → never enqueue) |
| coalesce — collapse intents in a window | scheduler — **theirs** |
| **scope** — recompute only changed key | **this doc** (change-feed row-ids → `affectedMap`) |
| bound — one concurrency gate | scheduler — **theirs** |
| account — count every recompute | scheduler — **theirs** |

And their §7 "honest residual" — *"admission does not reduce the intrinsic cost of a
single recompute… an orthogonal, irreducibly per-loader axis (compute the delta, not
the whole graph)"* — **is exactly this doc's incremental-reads half (§6).** Their
doc names it, scopes it out, and hands it here.

**The single shared contract both tasks must agree on before either ships:**

```ts
// The recompute intent carries the delta — never a bare dirty bit.
type RecomputeIntent = { resource: string; key: ResourceParams;
                         delta: { table: string; ids: string[]; op: "I"|"U"|"D" } | "FULL" };
```

The change-feed (this doc) **produces** delta-bearing intents; the scheduler (their
doc) **admits** them. Not two funnels — one feeds the other. One enforcement spine,
one CI budget (§7), shared — not minted twice.

> **Correction to their §10:** Layer-2 is listed as "missing." The *mechanism*
> landed (`affectedIds`/`affectedMap` in `runtime.ts`; `attempts`/`tasks` use it).
> What's missing is its *source* (DB-derived ids, this doc) and its *enforcement +
> universal adoption* (their doc). We agree on the gap; only the label is off.

## 4. Survey synthesis — four archetypes, and where each fits us

Full prior-art is in the `2026-04-26-sync-design-*` series and fresh agent reports.
Production sync engines cluster into four archetypes:

| Archetype | Examples | Dependency tracking | Incrementality | Infra cost |
|---|---|---|---|---|
| **Read-set + log-overlap** | Convex, MobX, Solid | runtime read-set (index ranges) | none — full re-run on hit | none special (in-process) |
| **CDC / shapes / buckets** | ElectricSQL, PowerSync | static shape (table+WHERE) | per-row replay | WAL consumer + replication slot |
| **Differential-dataflow IVM** | Zero/Materialite, Materialize, DBSP, **pg_ivm** | compiled query graph | true O(Δ) | dataflow engine / PG extension |
| **Persisted model-graph + catch-up** | Linear | model decorators (MobX) | per-property patch | client object pool + `lastSyncId` |

**What fits Singularity (single-user, embedded Postgres, ~1 active worktree):**

- **Convex's idea, not its engine.** Read-set capture is the right *dependency*
  primitive — but we get it almost for free (§5): the DB pool wrapper already runs
  every loader query under the loader's `AsyncLocalStorage` context. Convex does
  full re-run on hit; we already have Layer-2 to do better.
- **CDC, the cheap slice.** We want the *write-set source* CDC provides, but **not**
  logical-replication's slot/WAL/disk lifecycle. **Postgres triggers + `LISTEN/
  NOTIFY`** give us table+id+op transactionally (NOTIFY delivers on commit) with
  trigger DDL auto-generated on boot — the same DDL-on-boot the derived-views plugin
  already does, and the same direct-socket `LISTEN` graphile already uses.
- **IVM, only where it pays.** A full dataflow engine is the wrong size (the April
  doc judged it 2–4k lines + years of operator bugs). **`pg_ivm`** is the realistic
  on-infra form for *specific* heavy aggregations: a Postgres extension that
  maintains a materialized view incrementally via `AFTER` triggers, *in the write
  transaction* — collapsing both problems at once for the queries it supports
  (restricted SQL subset; FP-aggregate & min/max caveats).
- **Linear's catch-up, server-side.** A durable monotonic position is what makes
  *persisted* materialization (L2) crash-safe — relevant only at the high rungs.

## 5. Part A — Structural consistency (the intent source)

Two self-contained layers behind the **unchanged** `defineResource` /
`useResource` API. The authoring surface *shrinks*: `notify()` and most
`dependsOn` are deleted.

### L3 — read-set capture (replaces hand-drawn `dependsOn`)

The DB pool wrapper (`database/server/internal/client.ts`) already records every
query as a `db` span attributed to the enclosing loader via the runtime-profiler's
ALS `EntryContext`. Extend that one chokepoint to also record the **set of tables**
each loader touched → an automatic `table → [resource keys]` index.

- Drizzle holds the structured query, so table extraction is reliable; raw
  ``sql`…` `` falls back to "whole-table, over-invalidate" (correct, coarse).
- This **replaces** the hand-asserted `dependsOn` edge: `attempts`'s loader reads
  `conversations`, so `conversations → [attempts]` exists with no authored edge.
- **Precision: coarse match, precise scope.** Table-level *matching* answers "which
  resources"; the *write side* (a trigger knows `NEW.id`) supplies row-ids that feed
  Layer-2 *scoping*. Predicate-level matching (Convex index-ranges, "only if
  `listId=X`") is a later refinement that parses each loader's WHERE — **out of the
  first cut.**

### L4 — DB change-feed (replaces hand-called `notify()`)

Generic `AFTER INSERT/UPDATE/DELETE` triggers `pg_notify('live_state', {table, id,
op})`; **one** `LISTEN live_state` connection on the direct socket (the `adminPool`
path graphile already uses — pgbouncer breaks `LISTEN`). The listener maps changed
table → affected resources (via the L3 index) and emits a `RecomputeIntent` per
affected `(resource, key)` with the row-id as the delta — into the existing
cascade / scheduler.

- **Why triggers+NOTIFY over logical replication:** ~20 lines of *derived* DDL (the
  trigger set = exactly the tables the read-set index says someone reads,
  regenerated on boot — nothing hand-maintained), no slot lifecycle, no WAL disk
  risk, reuses the graphile `LISTEN` pattern. Logical replication stays a swap-in
  behind the same L3 primitive *if* L2 persistence ever needs an LSN (§6).
- **Catches what hand-notify can't:** out-of-process writes (agents' `psql`, the
  fork, MCP) — invisible to an in-process tracked-`tx` proxy, visible to the DB.
- **Reconcile fallback** (git-watcher's pattern): a periodic version-probe / mark-
  stale-on-reconnect covers a dropped `LISTEN` connection, so a lost NOTIFY can
  never strand state.

### What the consumer writes (the API shrinks)

```ts
const attemptsResource = defineResource({
  key: "attempts",
  schema: z.array(Attempt),
  keyOf: (a) => a.id,                       // opt-in: delta wire + row-scoped recompute
  loader: async (_p, ctx) => db.select()…,  // a pure read — reads `attempts` + `conversations`
  // NO notify() at any mutation site.   NO dependsOn edge.   mode → internal hint.
});
```

- **`notify()` deleted** from all ~155 DB-mutation sites.
- **`dependsOn` deleted** where it's just "reads table T" (captured); the one survivor
  is **`affectedMap`** — the upstream-id → downstream-id *join* the read-set can't
  infer ("this changed conversation belongs to *that* attempt"). It becomes the
  *only* authored cross-resource coupling. Later refinement: derive it from FK
  metadata.
- **Escape hatch (honest residual):** non-DB-source resources (git-watcher,
  file-watcher, transcript reads — April issue #12) keep an explicit change signal.
  They already call `notify()` from a *real* change detector, which is correct.
  `notify` goes from "the rule for every mutation" to "the exception for non-DB
  sources." If expensive, those materialize computed state into a DB table (L5) and
  rejoin the feed.
- **Client API `useResource(descriptor)` is byte-identical** — the stable contract.

## 6. Part B — Incremental reads (per-recompute cost: the ladder)

Their §7 residual. A **ladder of self-contained, opt-in, per-resource** layers, all
fed by the same delta — *not* an engine property. The one co-design constraint is
already met: the intent carries the delta (§3), so incrementality layers on top.

| Rung | What | Status | Kills |
|---|---|---|---|
| **L0** full recompute on invalidate | today's `push`/`invalidate` | exists | — |
| **L1** scoped recompute | Layer-2 `WHERE id IN (…)`, fed by L4 row-ids | mechanism exists; source from L4; **make universal** | cascade amplification |
| **L2** persisted materialization | durable resource value; cold boot = read snapshot + apply Δ since position | new | **cold-load cost (>4 s)** |
| **L3** true IVM | `pg_ivm` IMMV / incremental matview — maintained in the write txn | new, selective | intrinsic aggregate cost |

- **Most resources → L1**, automatic once L4 supplies ids. The heavy full-recompute
  loaders that have *no* Layer-2 path today (the `conversations` 4-query aggregate,
  `agent-launches` full join) get an `affectedMap` and graduate — mechanical,
  per-resource, no new engine.
- **L2 is the cold-load fix.** Today's cache is in-memory (lost on restart); persist
  the materialization so a deploy reads a snapshot + a small catch-up, not a full
  rebuild. **Re-coupling caveat:** L2 needs a *durable monotonic position* (Linear's
  `lastSyncId`) so a restart doesn't double-apply or skip a delta. Triggers+NOTIFY
  carry no position → this is the rung that tilts toward **logical replication** (LSN
  for free) or **`pg_ivm`** (sidesteps it by maintaining in-txn). Below L2,
  triggers+NOTIFY suffice.
- **L3 = `pg_ivm`** for the few queries in its subset (the `conversations` aggregate
  is a candidate). An IMMV is always-fresh → that resource needs *no notify, no
  Layer-2, no cache, no cold recompute* — the cleanest possible end state for those.
  Precision tool, not universal (restricted SQL; loaders that shape in TS don't fit).
- **Git/fs loaders** (`edited-files`, `commits-graph`, stats) are a separate cost
  class CDC can't touch. Incremental there = cache parsed git state + apply only new
  commits (the git-watcher already gives the change signal). Noted as follow-up.

## 7. The single path — one funnel, enforced, can't re-fragment

Both this doc and the work-admission doc independently demand *one un-bypassable
path, enforced by checks, that can't re-fragment*. They must share **one** spine,
or we get two parallel meta-systems — the exact anti-pattern. This is **not** a new
primitive beside `defineResource`; it **is** `defineResource`, evolved — these are
internal strata (L0–L5) behind the same call. The consumer never sees the layering.

Enforcement, in three layers of decreasing strength (mirroring the work-admission
doc's §6 so they compose, not collide):

1. **By construction.** The runtime exposes only `getResourceValue` (read) and the
   change-feed (invalidate); `entry.loader` is private; no caller runs a loader or
   touches the pool off-path.
2. **Checks for the residual.** The existing `./equin check` idiom
   (`no-raw-websocket`-style) extended: forbid a new parallel read system; forbid
   direct `pool.connect()` bypasses (already exists); assert the trigger set covers
   every written table (auto-derived, so this is a consistency check, not
   hand-work).
3. **A CI cost-budget gate** (shared with the work-admission doc): *idle recompute
   volume ≈ 0* and *notify→deliver p99 < X*, asserted under a load/CI harness.

### Self-verifying migration (how we collapse to one path without a big bang)

The change-feed and hand-`notify` run in parallel only during migration, and their
divergence is **automatically surfaced**:

- Once L4 covers a table, every surviving hand-`notify()` on a DB-backed resource is
  *provably redundant* — the feed already fired it → **delete it.**
- A hand-`notify()` that the feed does **not** cover is a **read-set gap** — it
  points straight at a table the L3 capture missed. The hand-notify becomes a
  *detector* for the exact bug class we're eliminating, then gets removed.

## 8. Phasing — independent, shippable layers in order

Each layer ships and proves out alone, behind the unchanged API.

1. **L3 read-set capture** — extend the pool-wrapper chokepoint to record tables;
   build the `table → [resource]` index; expose it (debug pane). *No behavior change
   yet — just observability of the real dependency graph (and a diff vs the
   hand-drawn `dependsOn`, which surfaces existing bugs).*
2. **L4 change-feed** — generic trigger DDL on boot + one `LISTEN` consumer →
   `RecomputeIntent` into the existing cascade. Run **alongside** hand-`notify`
   (self-verifying migration, §7). *Structural consistency lands here.*
3. **Delete hand-`notify` + most `dependsOn`** per table, as the feed proves
   coverage. *The API shrinks; weakness #1 closed.*
4. **L1 universal** — give the heavy full-recompute loaders an `affectedMap`; make
   scoped recompute the default (co-owned with the scheduler's "scope mandatory").
5. **L2 persistence** *(decision point)* — persist the materialization for
   boot-critical resources; adopt a durable position (logical-replication **or**
   `pg_ivm`) only here. *Weakness #2 (cold load) closed.*
6. **L3/pg_ivm** — back the 1–2 expensive aggregations with IMMVs. *Selective.*

Steps 1–3 are the consistency win and depend on nothing from the scheduler. Step 4
is the co-design handshake with the work-admission scheduler. Steps 5–6 are the
cost win and are independently schedulable.

## 9. Acceptance criteria (the sibling doc's symptoms, as outcomes)

Each symptom becomes a *deletion* or *trivial adoption* under this architecture +
the scheduler — treated as acceptance criteria, not independent work:

| Symptom | Resolved by | Becomes |
|---|---|---|
| Stale UI after close/push (missed-notify class) | L4 DB-derived feed | deletion (impossible) |
| Stale UI after push (blocked-flush class) | scheduler (delivery off flush) | their lever |
| `config-v2.scopes` thousands of runs at idle | L3∩L4 "skip if unchanged" + admit-if-subscribed | trivial |
| `conversationsLive→attempts→tasks` amplification | captured read-set + L1 row-scope | deletion |
| `edited-files`/`commits-graph` re-run per event | scheduler coalesce + git-state incremental (follow-up) | trivial + follow-up |
| Cold load >4 s / fan-at-idle | L2 persistence + admit-if-subscribed | trivial |

## 10. Non-goals / open questions

- **Predicate-level read-sets** (Convex index-ranges) — table-level match + row scope
  first; predicate matching is a later precision refinement.
- **Logical replication** — not in the first cut; the swap-in behind L3 if L2 needs
  an LSN. Avoid the slot/WAL/disk lifecycle until a measured need.
- **`pg_ivm` operational** — requires `shared_preload_libraries` + `CREATE
  EXTENSION` on the embedded cluster; restricted SQL subset; FP-aggregate / min-max
  caveats. Pilot on one resource before broad use.
- **Auth hook** — single-user today; the read-set / delta filter should leave a seam
  for a per-subscriber predicate (April issue #9) without building it now.
- **Multi-writer / multi-process** — the DB-derived feed is the design that survives
  it; in-process tracking would not. No further work needed beyond choosing the feed.

## 11. Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — registry entry
  gains read-set + the change-feed → intent path; `RecomputeIntent` type; the
  cascade already exists (`flushNotifies`, `mergePending`, `affectedMap`).
- `plugins/database/server/internal/client.ts` — pool wrapper is the L3 read-set
  capture chokepoint (already records `db` spans under the loader's ALS context).
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` +
  `server/internal/install.ts` — the ALS `EntryContext` the read-set rides on.
- `plugins/database/plugins/derived-views/server/internal/rebuild.ts` — the
  DDL-on-boot precedent the L4 trigger generation mirrors (and the L3-pg_ivm home).
- `plugins/database/server` (`adminPool`) — the direct-socket `LISTEN` connection
  (graphile already uses this path; pgbouncer breaks `LISTEN`).
- `plugins/infra/plugins/git-watcher/server/internal/watcher.ts` — the non-DB-source
  pattern + reconcile-timer fallback to mirror.
- `plugins/framework/plugins/server-core/core/resources.ts` — `defineResource`
  facade + `Resource.Declare` (where `bootCritical` / future recompute-policy live).
- `plugins/infra/plugins/boot-snapshot/server` — L2 persistence consumer.
- `plugins/framework/plugins/tooling/plugins/checks/...` — the shared enforcement
  checks + CI cost-budget (co-owned with the work-admission doc).

## 12. Verification

- **L3 capture correct:** a debug pane lists the captured `table → [resource]` index;
  diff it against the hand-drawn `dependsOn` — every existing edge appears, and
  *extra* captured edges are real dependencies the hand graph missed (each is a
  latent stale-UI bug, confirmed by mutating that table with the old code).
- **L4 consistency:** with all hand-`notify()` removed for a table, mutate it via
  `psql` (out-of-process) → open tabs update. Mutate via the app → update. Drop the
  `LISTEN` connection → reconcile fallback recovers within its window.
  (`get_runtime_profile` + the queue/notify debug panes.)
- **Self-verifying migration:** instrument the parallel period — assert every
  hand-`notify()` fire is preceded by a feed-derived intent for the same
  `(resource, key)`; any un-matched hand-`notify()` is logged as a read-set gap.
- **L1 universal:** `get_runtime_profile kind:"loader"` shows the `conversations`
  aggregate recomputing *scoped* (one key) under a single-row change, not a full
  4-query rebuild.
- **L2 cold load:** after `./equin build` + restart, first paint of
  `http://<worktree>.localhost:9000` reads the persisted snapshot (low-ms) instead of
  the ~4 s full rebuild; the rebuild cost, if any, is a bounded catch-up.
- **Idle ≈ 0 (shared budget):** with no subscriber and no DB write, `get_runtime_
  profile` shows **zero** loader runs over a quiet interval; the CI budget gate
  asserts it.
- `./equin check` passes, including the new bypass + trigger-coverage checks.
