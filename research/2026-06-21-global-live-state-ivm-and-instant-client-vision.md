# Vision: closing the gap to a real sync engine — server-side IVM + instant client

> Status: vision / direction doc, not an implementation plan. It frames where the
> live-state stack is today, the two gaps that separate it from a "real" sync
> engine, and a phased, primitive-by-primitive path to close each — reusing what
> already exists rather than adopting a second system.

## Context

equin's live-state is a **server-push** model: the source of truth and the
query execution stay on the server; deltas push to the browser over a
leader-elected WebSocket. It already has most of a reactive dataflow engine —
the `dependsOn` DAG (the dataflow graph), the L4 change-feed (the input delta
stream), `affectedMap` (the per-edge delta function), `identityTable`/
`coveredOrigins` (scoped-vs-FULL routing), keyed delta sync, and read-set capture
(the runtime truth of what each loader touched).

Measured honestly against the two families of "real sync engine," two gaps
remain — and they are the two axes of this doc:

1. **Server-side incremental generality.** Today scoped recompute is *manual*:
   an author hand-writes `affectedMap`, and anything it can't express degrades to
   a FULL recompute. The delta function can silently drift from what the loader
   actually reads (the "silent FULL" / ceiling problem). A real IVM engine
   (Materialize, Feldera/DBSP) derives deltas automatically and maintains
   joins/aggregates incrementally with provable correctness.

2. **Client-side instant feel.** Today reads execute on the server; every
   interaction that re-queries pays a round trip (softened by boot-snapshot +
   caching, not eliminated). A local-first engine (ElectricSQL, Zero, Convex,
   Linear) runs the query *in the browser* against a local store → 0ms reads,
   instant filtering/sorting, offline, and instant optimistic writes.

**Reframe up front:** parity on *every* axis means becoming one of those systems.
For equin's actual workload — a personal OS, mostly single-user/small-group,
server-trusted, modest concurrency — the axes where a sync engine wins (offline,
massive fan-out, write firehose) matter far less than the axis users *feel*
(instant local interaction). So the goal is not "beat Materialize at IVM"; it is
**"feel as instant as Linear for the personal-OS workload, while shrinking the
manual-delta surface so correctness is structural, not vigilance."**

## North star

> Every resource is, by default, a **declared query** the engine understands well
> enough to (a) maintain incrementally on the server and (b) replicate + execute
> locally in the browser — from **one source of truth**, so the loader, its delta
> function, and its client shape can never drift. Arbitrary loaders remain an
> escape hatch, instrumented so their cost is visible.

The same scoped-delta machinery serves both axes: **the server's scoped delta
stream *is* the replication protocol for the client store.** Build it once, win
twice.

---

## Axis A — Better server-side IVM

Goal: shrink the manual-`affectedMap` surface and the FULL-recompute fallback,
turning hand-written deltas into *derived* ones for the expressible majority.

### A1. Declarative query primitive → derive loader **and** delta together
The root cause of drift is that the loader (`f`) and its delta (`affectedMap`,
`Δf`) are written separately by hand. Introduce a constrained relational builder
for the common case (`from(tasks).join(users, …).where(…).select(…)`). From one
declaration the engine generates **both**:
- the full loader, and
- the `affectedMap` for each base table the query reads (which result rows a
  change to table X affects).

Result: for declared resources, the silent-FULL class becomes **structurally
impossible** — `coveredOrigins` always equals the real read-set by construction.
Builds directly on the existing `entities` primitive (one `FieldsRecord` →
Drizzle table + zod) and `resource-runtime`. This is the highest-leverage move.

### A2. `pg_ivm` spike for the expressible subset
`pg_ivm` (Postgres extension) maintains incremental materialized views via
triggers, *inside the DB we already fork per worktree* — no second system. Spike:
back a declared resource's query with an IMMV and let the change-feed observe the
IMMV's own row deltas. Where the query fits `pg_ivm`'s supported algebra, we get
true engine-maintained incrementality for free; where it doesn't, fall back to
A1's derived `affectedMap`, then to FULL. Lowest-friction "real IVM" toehold.

### A3. Read-set-driven coverage, auto-suggested deltas
The read-set capture already knows, at runtime, exactly which tables each loader
touched. Use it as a *generator*, not just a *linter* (the ceiling diagnostic):
for a loader reading table T with no covering edge, propose a candidate
`affectedMap`/`identityTable` from the captured join shape. Closes the loop:
observe drift → suggest the fix → (eventually) derive it.

### A4. Shared computation — compute once, fan out the delta
Today the diff fan-out is per-socket (`subCounts`), so work scales with
subscribers on a hot resource. Move toward **maintain the view (and its delta)
once per params-tuple, then broadcast the same delta to all subscribers** — the
amortization a real IVM engine gets for free. The level-parallel flush and keyed
snapshot machinery are the foundation; the change is to hoist the diff above the
socket loop. Matters only at higher concurrency, but it's the structural ceiling
on fan-out.

### A5. (Stretch) DBSP-style algebra for the hard 20%
For complex live aggregates/windows that A1's DSL can't express incrementally,
study DBSP (Z-sets + incremental operators — the clean theory behind differential
dataflow). Likely an embedded compute path for a *small* set of analytical
resources, not a wholesale rewrite. Explicitly a research track, not a near-term
commitment.

**Honest ceiling for Axis A:** even fully realized, this matches a real IVM
engine only on the subset the DSL/`pg_ivm` covers. General-purpose incremental
joins+aggregates at firehose write rates remain Materialize/DBSP territory. That
is an acceptable non-goal for the personal-OS workload.

---

## Axis B — Better client-side (the instant feel)

Goal: convert "round-trip on every interaction" into "0ms local read," which is
~90% of what makes sync engines *feel* fast. Build a real client read store fed
by the server's scoped delta stream.

### B1. Client-side read store
Extend the existing **boot-snapshot** (already hydrates boot-critical resources
before first paint) and **optimistic-mutation** (overlay/replay, rollback) into a
durable, queryable client store (in-memory now; IndexedDB/SQLite-wasm later for
persistence + offline). The server's keyed delta sync becomes the store's
replication feed — no new protocol.

### B2. Partial replication via query "shapes"
Don't ship the whole DB. A client subscribes to a **shape** (a declared query
from A1's builder, scoped to the user's working set); the server replicates only
matching rows and streams scoped deltas as the shape's membership changes. This
is the ElectricSQL "shapes" model, expressed in the *same* declarative primitive
that drives Axis A — so server IVM and client replication share one query
definition.

### B3. Local query execution → 0ms reads
Once the working set is local, run filter/sort/derive **in the browser** against
the store. Typing in a search box, toggling a filter, reordering — all become
local recomputes with no network. This is the single biggest felt-latency win and
the defining property of "instant." The declarative builder (A1) is what makes a
query runnable in both places.

### B4. Offline + reconnect reconciliation
With a persistent local store, reads and optimistic writes work offline; on
reconnect, replay the scoped delta log from the last-seen version (the keyed
versioning already exists per pk) and reconcile pending optimistic ops. Turns the
existing optimistic primitive into genuine offline-first.

### B5. Optimistic-everything, reconciled against real deltas
Generalize `useOptimisticResource`: every mutation applies to the local store
instantly and reconciles when the authoritative scoped delta arrives (confirm or
rollback). Combined with B3, writes *and* reads feel local.

**Honest ceiling for Axis B:** this genuinely closes the felt-latency gap, but
note that at that point we *have built a local-first sync engine* — which is the
correct conclusion: reaching parity on instant-local-reads means adopting that
architecture. The win is that we adopt it **on top of our own scoped-delta
transport and declarative primitive**, not by bolting on a foreign system.

---

## Where the two axes meet

```
                 ┌─────────────────────────────────────────────┐
                 │   ONE declarative query primitive (A1)       │
                 │   from(...).join(...).where(...).select(...)  │
                 └───────────────┬─────────────────────┬────────┘
        derives ▼                                       ▼ derives
   server loader + affectedMap                 client shape + local query
   (Axis A: scoped IVM, no drift)              (Axis B: partial replication,
                 │                                       0ms local reads)
                 └──────────────► scoped delta stream ◄──┘
                        (one transport: keyed delta sync over WS —
                         server incremental maintenance == client
                         replication feed)
```

The declarative query is the keystone: it is simultaneously the thing the server
can differentiate (A) and the thing the client can replicate + run locally (B).
The scoped delta stream is simultaneously the IVM output (A) and the replication
protocol (B). One investment, both gaps.

## Phasing (each phase shippable + independently valuable)

1. **Ceiling diagnostic** (the current task) — make manual-delta drift *visible*.
   The meter that tells us which resources most need A1. Ship first.
2. **A1 declarative primitive** — derive loader + `affectedMap` from one
   declaration for the common case. The structural keystone; eliminates the
   silent-FULL class for declared resources.
3. **A3 read-set-driven suggestions** — auto-propose coverage from captured
   read-sets; accelerates migrating loaders onto A1.
4. **B1 + B2 client store + shapes** — replicate the working set over the
   existing delta transport.
5. **B3 local query execution** — the instant-feel payoff.
6. **A2 `pg_ivm` spike / A4 shared fan-out / B4–B5 offline** — depth where the
   workload demands it.
7. **A5 DBSP** — research track, only for proven complex-aggregate needs.

## Non-goals (honest scoping)

- Multi-tenant collaborative SaaS at huge fan-out / firehose write rates — that's
  Materialize/Zero turf and not the personal-OS workload.
- General-purpose incremental joins+aggregates beyond the DSL/`pg_ivm` subset.
- Replacing the arbitrary-loader escape hatch — it stays, instrumented by the
  ceiling diagnostic.

## How we'll know we're closing the gap (measurement)

- **Axis A:** count of FULL-recompute resources and silent-FULL flags trending to
  zero as resources migrate to A1; server CPU per write; ratio of scoped vs FULL
  deliveries (from the read-set / debug surfaces).
- **Axis B:** p50/p95 interaction latency (filter/sort/keystroke) before vs after
  the local store; round-trips per interaction; cold-boot time-to-interactive.
- **Felt parity bar:** a search/filter on a working-set list updates with no
  network round trip, and a cross-client edit lands on a second screen within a
  few ms over the existing scoped path.
```
