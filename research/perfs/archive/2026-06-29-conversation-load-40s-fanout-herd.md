# Conversation load 40+ s — traced to the subscribe/reconnect fan-out herd (loaders are victims)

> **⚠️ SUPERSEDED FRAMING (2026-06-29, same day, later session).** This doc correctly identifies the
> fan-out herd as the **trigger** and the loaders as **victims**, but it stops one layer too low: it
> attributes the wall-clock to DB-pool/gate queueing. A later pass measured that the 40 s is actually a
> **single ~46 s synchronous event-loop block** on the main backend (PG idle during it; not GC; not the
> git gate). Read **[`2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md`](./2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md)**
> first. The serve-stale design below is preserved but **demoted** (a blocked loop can't send the stale
> value either).

**Date:** 2026-06-29
**Status:** findings only — root cause confirmed beyond doubt (three converging lines).
**No code changes.** Names fix altitudes; awaiting decision before any fix.
**Trigger:** "Sometimes, loading a conversation takes 40+ secs." Started a fresh
investigation per the [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md)
method (re-validate, don't inherit).

## TL;DR

Loading a conversation that takes 40+ s is **not** slow conversation work and **not** the
git loaders being slow. It is the **live-state subscribe fan-out herd**: when a backend
restarts or a WebSocket reconnects, *all* live-state resources for *all* open tabs
re-subscribe in one burst and each cold-misses its loader at once. The per-backend
**16-connection DB pool (10 loader slots) and the single event loop** cannot absorb ~30
simultaneous cold loaders, so every loader's DB query queues for tens of seconds. The
conversation's own loaders (`edited-files`, `commits-graph.delta`, `jsonl-events`) are
**downstream victims** of that herd, not the cause.

This is the [`cold-boot fan-out`](./issue-cold-boot-fanout.md) issue — refined: it also fires
on **WS reconnect**, not just boot, and the dominant wait is the **per-backend DB-pool
loader gate**, not the host heavy-read git gate.

## Evidence (three converging lines)

### 1. Live `get_runtime_profile` (singularity, main) — the herd signature

- **First-subscribe (`sub`) fan-out, simultaneous:** 9 subscribes each of 8 distinct
  resources — `edited-files` (avg 3.49 s, max 7.87 s), `commits-graph.delta` (3.0 s / 7.71 s),
  `agent-launches`, `pushes`, `tasks`, `queue-ranks` — **all maxing within ~1 s of each
  other (6.8–7.9 s)**. Independent subscribes spread over time do not cluster like that; this
  is one shared stall window, repeated (avg ≈ 2.5–3.5 s over 9 occurrences ⇒ recurring herds,
  i.e. reconnects, not a one-off boot).
- **Dominant wait is the DB pool, not the git gate.** Loader `waits` (cumulative):
  - `edited-files`: `loader-acquire` ≈ 1090 ms/call; `heavy-read-local` 27 ms; `heavy-read-acquire` 64 ms → **DB-pool-bound**.
  - `commits-graph.delta`: `loader-acquire` ≈ 1141 ms + `heavy-read-local` ≈ 1246 ms + `heavy-read-acquire` ≈ 397 ms → DB-pool **and** per-worktree git gate.
- **`flushNotifies` max 10.7 s** in the window (avg 401 ms over 53 cycles) — the herd-stalled flush.
- Every db `<sql>` span reports `workMs == avgMs` (no waits at the db level — the wait is split
  into the separate `[acquire]` span) yet simple indexed `select`s on `tasks`/`attempts`/`pushes`
  show **maxMs of 6–7 s**. A PK/indexed select cannot *execute* for 7 s — that inflated time is
  **event-loop congestion + the hidden pgbouncer server-connection wait** during the herd, not query work.

### 2. Durable `slow_ops` (singularity) — the 40 s symptom, clustered in herd windows

Recent (last 6 h), ordered by `last_ms`:

| op | last_ms | last_seen |
|---|---|---|
| `GET /api/stats/cost/*` (8 endpoints) | 65–77 s | 14:35 (all simultaneous) |
| `GET /api/code/:worktree/push` | 47.5 s | 14:46 |
| `edited-files {conv-…}` (element) | **46.5 / 43.0 / 35.9 s** | 14:55–15:12 |
| `commits-graph.delta {att-…}` | **40.2 / 15.3 s** | 14:46–15:12 |
| `jsonl-events {conv-…}` | 37.3 s | 14:46 |
| `flushNotifies` | 10.7 s | 15:23 |
| `[heavy-read-local]` (db) | 10.9 s | 15:12 |

The **8 stats/cost endpoints all maxing at 65–77 s at the same instant (14:35)** is the same
shared-stall signature: one pool/event-loop saturation event, not per-endpoint slowness. The
40 s conversation loaders cluster in the adjacent 14:46–15:12 window.

Cumulative pool gate: **`[acquire]` count 54,129, total 154 M ms, max 75.9 s** (the DB
connection-pool checkout wait). This is the scarce resource.

### 3. `benchmark_boot` (singularity) — loaders are fast in isolation AND under host-gate saturation

Run with `loadConcurrency 8` (host heavy-read gate saturated):

| first-subscribe | cold median | warm median |
|---|---|---|
| `edited-files` | 1.41 s | 1.34 s |
| `commits-graph.delta` | 0.70 s | 0.62 s |
| `commits-graph.graph` | 1.12 s | 0.14 s |

Event-loop max ≈ 160 ms cold / 108 ms warm. **None is 40 s.** So the 40 s is **not** loader
work and **not** the host git gate (saturating it adds nothing material). It is the full
per-backend fan-out — which `benchmark_boot` deliberately does **not** reproduce (it saturates
only the host git gate, and cold-misses ~7 boot-critical keys, not the full ~30-resource
reconnect herd + the 10-slot loader DB gate).

## Phase-0 re-validation of the prior "Completed" churn fix — holding

The no-op churn fix (`1f6b27092`) is **not** regressed:
- `conversations` INSERT rate: **7 / hour** (legitimate), not the old 4 / s no-op churn.
- `live_state_snapshot`: **20 MB / 20 live rows** (autovacuumed 15:25), bounded — not the old 188 MB.

So the residual 40 s is a *different* driver than the churn: the **fan-out herd → DB-pool +
event-loop saturation**, which the churn fix never targeted.

## Topology (why the pool saturates)

- **Per backend** (`plugins/database/server/internal/client.ts`): node-postgres `pool.max = 16`,
  `RESERVED_INTERACTIVE = 6` → **loader queries gate to 10 concurrent** (`loaderDbGate`).
- **PgBouncer** (`plugins/database/plugins/pgbouncer/scripts/start.ts`): `pool_mode = transaction`,
  `default_pool_size = 16` per DB (catch-all routes each worktree DB to its own pool),
  `max_client_conn = 200`; PG `max_connections = 500`. PgBouncer/PG are **not** the limit — the
  10-loader-slot per-backend gate + the single event loop are.

A live-state cascade flush (and a reconnect re-subscribe) can fire ~10–30 dependent loaders in
one microtask. With 10 loader slots, the 11th+ loader's query queues; under the herd the queue
depth × per-query event-loop-delayed completion compounds into the 40–75 s tails.

## Stopping gates (per the method)

1. **Sufficiency:** the herd's simultaneous ~30-resource fan-out, against 10 loader slots + 1
   event loop, reproduces the 40–75 s tails (the stats family at 65–77 s and the conversation
   loaders at 35–46 s share one stall window). ✅ arithmetic closes.
2. **Legitimacy:** the fan-out is **illegitimate as shaped** — on reconnect/boot, resources
   whose data did not change still cold-recompute, all at once, with no admission control,
   staggering, or snapshot-serving for non-boot-critical keys. Root is **above** the loaders.
3. **Counterfactual:** fixing a loader (e.g. parallelizing `edited-files`' git spawns) makes the
   herd *cheaper*, not *gone* — containment. The cure is to **not run the whole herd at once**.
4. **Requirement boundary:** a user opening a conversation legitimately needs *that
   conversation's* resources; it does **not** require every other tab's resources to recompute
   simultaneously. The simultaneous fan-out is the removable part.

## Fix altitudes (name each — do not crown one "the root")

- **Origin / rate axis (the cure):** bound the subscribe/reconnect fan-out. Options: admission
  control / staggering on cold loader recomputes; serve on-demand resources from the L2 snapshot
  on reconnect (only recompute keys whose tables changed during the gap — the catch-up machinery
  already exists for boot-critical keys); prioritize first-paint-critical resources. Removes the
  herd itself.
- **Boundary invariant (containment, class-wide):** cap simultaneous cold loader recomputes so a
  reconnect can never enqueue ~30 at once and starve the pool/event loop for any caller.
- **Cost axis (containment):** widen the loader gate / pool for the boot/reconnect window; make
  `edited-files` cheaper — it is **~1.4 s even warm** (4 serial git spawns: `merge-base`,
  `diff --name-status`, `status --porcelain`, `diff --numstat`), the steady-state per-conversation
  floor, worth parallelizing independently of the herd.

## Open (for the fix-planning session)

- Confirm the herd is reconnect-triggered (not only boot): instrument what enqueues each
  fan-out burst (WS reconnect vs backend restart vs change-feed). The recurring avg (not one-off)
  strongly implies reconnects.
- Decide which on-demand resources can be snapshot-served on reconnect vs must recompute.

## Deeper trace (session 2 — "are we fixing the right level?")

Challenged that the session-1 altitudes (stagger / widen the gate / parallelize git) were
**containment**, the same level multiple prior weeks landed on. Climbed two more hops:

### Discarded: reconnect `fullSweep` is the trigger — ❌ killed by gate-1 (rate)

The 2026-06-23 boot fix (`ca4d2cd92`) made boot serve from the L2 snapshot + **bounded
catch-up**, but `change-feed/listener.ts:87-91` **deliberately keeps the unbounded
`fullSweep()` on reconnect** ("reconnects are rare"). Hypothesis: frequent reconnects fire
fullSweep → recompute-everything herds. **Refuted by the logs:** every "LISTEN established" is
preceded by "installed live_state triggers" — these 190 events are *server boots*, not
mid-session reconnects (on `firstConnect` the sweep is skipped). Genuine reconnects: **1**
("terminating connection due to administrator command"). So the reconnect-fullSweep path is
**not** the driver. (It is still a latent unbounded-recompute footgun if reconnects ever
become frequent — worth bounding defensively — but it is not this symptom.)

### Confirmed root: restart-driven fleet re-subscribe of **non-boot-critical, route-parametrized** resources

- **Main restarts ~20×/day** (every 10–46 min): boots today at 13:35, 14:01, 14:40, 14:52,
  15:20, 15:30. The 40 s loads land **right after** a boot (`commits-graph` 40 s at 14:46 ←
  14:40 boot; `edited-files` 46.5 s at 14:55 ← 14:52 boot). Each restart = a cold boot; the
  whole open-tab fleet's WS reconnects and **re-subscribes every resource at once**.
- **The boot-instant cure structurally excludes the conversation-load resources.** L2 persists
  **only `bootCritical` resources** (`live-state-snapshot/persist.ts`: filter `c.bootCritical`).
  17 resources are boot-critical — all **param-less list/aggregate** resources (tasks, agents,
  conversation-groups, queue-ranks, turn-summaries, notes…). The resources that dominate a
  *conversation* load — `editedFilesResource`, `commitDeltaResource`, `commitsGraphResource`,
  `jsonlEventsResource` — are declared **plain** (`Resource.Declare(x)`, no `bootCritical`),
  because they are **route-parametrized** (keyed by conversationId/attemptId; thousands of
  them, can't pre-persist all). So on every restart they are **cold on re-subscribe**, fleet-wide,
  simultaneously → the 10-slot loader gate + single event loop saturate → 40–75 s tails.

This is **why weeks of work didn't move it**: the snapshot/catch-up/churn fixes all targeted the
**param-less list** resources (the boot-snapshot surface). The conversation-load herd is the
**route-parametrized per-conversation** resources, which that architecture does not cover.

### Legitimacy gate at the new altitude

A restart in which conversation X's data did not change should re-serve X's last computed
`edited-files`/`commits-graph`/`jsonl-events` value — **not cold-recompute it**. Cold-recomputing
unchanged parametrized state on every restart is the illegitimate (no-op) work. Root is here, not
at the pool.

### Right-level fixes (re-named after the deeper trace)

- **Origin / cure — extend the proven snapshot + bounded-catch-up cure to *actively-subscribed*
  route-parametrized resources.** Persist the last value keyed by params for resources that have
  live subscribers (the working set, not all conversations); on a restart re-subscribe, serve from
  that snapshot and bounded-catch-up only the params whose tables changed during downtime. This is
  exactly `ca4d2cd92`, applied to the resources it currently excludes — the same machinery, not a
  new one. Makes a no-data-change restart a near-no-op for conversation load.
- **Rate axis — quantify and cut the ~20×/day main restart rate.** Each restart is the herd
  trigger; halving restarts halves the herds. Need attribution: agent `./equin build`
  hot-swaps vs health-monitor restarts vs crashes. (Out of scope to fix here, but it multiplies
  every other cost.)
- **Containment (only after the above) —** widen the loader gate for the boot window; parallelize
  `edited-files`' 4 serial git spawns (~1.4 s even warm). These reduce the *depth* of a herd but
  never remove it; do not lead with them.

## Raw data (this session)

- Profile: `…/tool-results/toolu_01XRhxWMsocPgMuSdJguvDrh.json`
- Benchmark: `…/tool-results/toolu_01X4f5mVWrgg4vbCF1ZqvK1Z.json`
