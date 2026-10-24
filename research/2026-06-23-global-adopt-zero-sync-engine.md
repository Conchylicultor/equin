# Adopt Rocicorp Zero as our sync engine (replace homemade live-state)

> Status: **Vision + staged roadmap.** This doc intentionally stays high-level. Each
> stage below becomes its own task that runs its own design phase. Open questions
> (exact gateway wiring, per-worktree replication-slot model, mutator/permission
> shape) are **deliberately deferred** to those subtasks — do not resolve them here.

## Context

We have built, by hand, a sophisticated server-side sync engine under the `live-state`
umbrella:

- **L4 change-feed** — STATEMENT-level Postgres triggers → `pg_notify` → a `LISTEN`
  consumer → a per-resource recompute cascade (`plugins/database/plugins/change-feed/`).
- **L2 materialization / IVM** — `live_state_snapshot` + xmin watermark +
  `live_state_changelog` cold-boot catch-up (`plugins/database/plugins/live-state-snapshot/`).
- **Client delta-sync** — `useResource`, keyed delta merge, leader-elected WS fan-out
  (`plugins/primitives/plugins/live-state/`).
- **Optimistic writes** — overlay/replay (`plugins/primitives/plugins/optimistic-mutation/`).
- **Boot hydration** — `infra/boot-snapshot`.
- **Per-query server code** — ~40 `defineResource` loaders; ~360 `useResource` call sites
  across 142 files; ~104 `defineEndpoint` write handlers.

This is effectively a hand-rolled Zero. It works, but we are **fighting subtle bugs in our
own sync engine** — invalidation edge cases, recompute-cascade correctness, delta-merge
churn, catch-up watermark races. These are exactly the problems a mature, dedicated sync
engine has already solved.

[Rocicorp Zero reached 1.0 (first stable release) in June 2026](https://www.infoq.com/news/2026/06/zero-version-1/).
It replaces our entire stack with: a `zero-cache` service holding a SQLite replica fed by
Postgres **logical replication**, **client-side IVM** (queries resolve against a local
replica in the next frame), **ZQL** (clients compose joins/filters/order with no per-shape
server code), built-in **optimistic custom mutators**, and partial/query-driven sync.

**Intended outcome:** delete our homemade IVM / change-feed / `defineResource` / optimistic
machinery and stand on Zero. Net less infrastructure to own, fewer correctness bugs, and a
strictly more capable client (arbitrary local queries, offline) — at the cost of a large,
staged migration and one real architectural question to solve (Zero × our worktree-fork model).

## Why this is feasible as a clean swap

`useResource` / `defineResource` is **already the abstraction seam**. The entire app reads
live state through that one interface, so Zero can be introduced behind an equivalent seam
and adopted call-site by call-site without a big-bang. The hard part is not the app surface —
it's the **infrastructure layer** (logical replication on the embedded cluster, and a
`zero-cache` instance per worktree DB), which is concentrated in `plugins/database/`.

## The one load-bearing unknown (flag, don't solve here)

Our killer constraint is the **per-worktree DB fork model**: each worktree gets its own
forked Postgres DB (`plugins/database/plugins/fork/`), dozens of them, ephemeral. Zero wants
**one `zero-cache` per upstream DB**, each holding a logical **replication slot** + its own
SQLite replica (initial COPY on first sync). Our current feed has ~zero per-worktree process
cost (just a `LISTEN`). Reconciling "ephemeral forked DB per worktree" with
"replication-slot + replica + supervised process per DB" is **the** design question for this
effort. It is owned by Stage 2 below — not this doc.

(Encouraging precedent: the gateway already has a generic, data-driven **service supervisor**
in Go reading `~/.singularity/database.json`, which is how embedded Postgres and pgbouncer
are run. zero-cache plausibly registers the same way. And `wal_level=logical` is an additive
GUC on our embedded PG18 cluster that **does not break** the existing trigger feed — so the
two sync engines can run side-by-side during migration. Both are inputs to Stage 2, not
conclusions.)

## Where it lives

A new self-contained umbrella — proposed **`plugins/database/plugins/zero/`** (sync engine =
database infrastructure; mirrors the `embedded` / `pgbouncer` precedent of "owns a supervised
`scripts/start.ts` + runtime barrel"). It owns the zero-cache service definition, the Zero
schema, the client/server runtime glue, and the `useResource`-compatible adapter. The exact
internal sub-plugin split is a Stage-1 decision.

## Staged roadmap

Each stage is a future task that designs and implements itself. Order matters: each builds on
the last and is independently shippable/reversible.

### Stage 0 — Spike (throwaway, single DB) — ✅ DONE (2026-06-23)
Prove Zero runs in our world at all. Enable `wal_level=logical` on the embedded cluster, run
one `zero-cache` against the **main DB only**, sync one tiny table slice (e.g. `tasks`),
render one leaf pane via ZQL. Everything else stays on live-state. Goal: validate the
mechanics and surface surprises before committing. Disposable.

> **Outcome: GO.** Logical replication runs against the embedded cluster (TCP connect, slot,
> initial COPY of all 80 tables, live streaming). zero-cache runs as a Node sidecar; the browser
> client connects cross-origin. The only unproven piece is the final client `useQuery`
> subscription (a Stage-1 wiring detail). Key surprises: **`rank_text` is unsupported and silently
> dropped** (our ordering primitive — high Stage-3 impact); **zero-cache needs Node 22/24, not Bun
> and not Node 25**; **a leftover replication slot retains WAL and blocks fork teardown** (high
> Stage-2 impact). Full writeup + evidence:
> [`2026-06-23-database-zero-spike-single-db.md`](./2026-06-23-database-zero-spike-single-db.md).
> The `wal_level=logical` + loopback-TCP prerequisite landed self-contained and is on `main`.

### Stage 1 — The `zero` plugin skeleton (self-contained, opt-in)
Stand up the real plugin home: Zero schema definition, zero-cache service registration, the
client provider, and a **`useResource`-shaped adapter** so call sites can move with minimal
churn. No worktree integration yet (still single-DB). Living on the side; nothing legacy is
touched or deleted.

### Stage 2 — Make it work with the gateway / worktree system ← the hard one
Solve the worktree-fork × zero-cache question (slot-per-fork vs. shared-cache vs.
schema-scoping vs. something else), wire provisioning into the DB fork lifecycle
(`plugins/database/plugins/fork/`) and teardown into worktree reaping
(`debug/worktree-cleanup/`), and route Zero's WS/HTTP through the existing per-subdomain
proxy. This stage has its own full design phase. After it lands, Zero works in any worktree
exactly like live-state does today.

### Stage 3 — Migrate a real, representative slice (validation)
Move one whole app/domain's resources from `defineResource` → Zero queries and its writes
from `defineEndpoint` → custom mutators. Run it **alongside** the legacy stack on real
surfaces. This is the go/no-go: confirm ergonomics, latency, churn, and correctness on
something non-trivial before committing to the long tail.

### Stage 4 — Migrate the rest
Sweep the remaining ~40 `defineResource` / ~360 `useResource` call sites / ~104 write
endpoints onto Zero, domain by domain, behind the same adapter. Mechanical and parallelizable
once Stage 3 sets the pattern.

### Stage 5 — Delete the homemade engine
Once nothing reads live-state, remove the legacy stack: `change-feed`,
`live-state-snapshot`, `boot-snapshot`, the `live-state` primitive, `optimistic-mutation`,
the `defineResource` runtime, and their triggers/changelog tables. This is the payoff — the
maintenance and bug surface goes away.

## Validation strategy (per stage)

- **Stage 0/1:** the pilot pane reflects DB writes live, with no live-state subscription
  behind it (verify via `query_db` write + observe UI, and by confirming the WS frames come
  from zero-cache).
- **Stage 3:** run the migrated domain and the legacy stack in the same app; compare
  correctness and behavior on the same mutations. Watch the existing churn/op-rate debug
  reports (`debug/live-state-churn`, `debug/op-rate`) for regressions.
- **Stage 5:** `./equin check` + `type-check` must pass with the legacy plugins
  removed; the boundary checker confirms nothing still imports them.

## Critical existing files (entry points for the subtasks)

- Live-state seam to mirror/replace: `plugins/primitives/plugins/live-state/` (web + core),
  `plugins/primitives/plugins/optimistic-mutation/`.
- Server resources to migrate: all `defineResource` loaders (~40); write handlers via
  `plugins/infra/plugins/endpoints/` (`defineEndpoint`/`implement`).
- Engine to delete: `plugins/database/plugins/change-feed/`,
  `plugins/database/plugins/live-state-snapshot/`, `plugins/infra/plugins/boot-snapshot/`.
- Cluster config (for `wal_level=logical`): `plugins/database/plugins/embedded/scripts/start.ts`.
- Worktree DB lifecycle hooks: `plugins/database/plugins/fork/` (provision),
  `plugins/debug/plugins/worktree-cleanup/` (teardown).
- Service supervision: gateway `supervisor.go` + `infra/launcher`'s `ensureDatabaseConfig`
  (writes `~/.singularity/database.json`).

## Non-goals for this doc

- Choosing the worktree × zero-cache topology (Stage 2 owns it).
- Designing the mutator/permission model or the auth/JWT bridge (Stage 1/3 own it).
- Settling the plugin's internal sub-plugin breakdown (Stage 1 owns it).
