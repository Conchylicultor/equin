# Super-Plan: Fixing the Structural Issues in the Communication Architecture

> Status: approved plan (design phase). Companion to the
> [communications audit](./2026-07-02-comms-audit/00-overview.md), which
> documents the current state and its issues, and to the
> [IVM/instant-client vision](./2026-06-21-global-live-state-ivm-and-instant-client-vision.md),
> whose Axis A this plan begins executing.
>
> Execution note: tracks are filed as equin tasks and implemented by
> Fable agents with ultracode — scopes are deliberately large per task.

## Context

The audit identified six structural issues in the DB↔Server↔Client stack:

1. **Vigilance-based incrementality** — scoped recompute depends on
   hand-written `affectedMap`/`identityTable` that can silently drift from
   what loaders actually read; everything else degrades to FULL recompute
   with no failure signal.
2. **Two half-committed sync engines** — the in-house live-state stack plus
   the Rocicorp Zero pilot (logical replication, Node sidecar, slot sweeps).
3. **Side-effect registration fragility** — the hand-maintained
   `DEFERRABLE_APPS`/`EAGER_EXCEPTIONS` eager-tier allowlists have broken
   twice (release, sonata/voicing); import-graph side effects are an
   invisible dependency system.
4. **No automated verification of the race-prone core** — the H1–H7 hazards
   from the v3 live-state design are verified manually; the client transport
   stack (`NotificationsClient`/`SharedWebSocket`/`CrossTabElection`) has
   zero tests and no injection seams.
5. **Unresolved deployment-model question** — single-user/single-machine
   assumptions run deep; whether that's debt or a decision was never written
   down.
6. **Write-path scaling ceilings** — per-subscriber keyed diffing, `pg_dump`
   forks that grow with main's data (with a hardcoded mail-table exclusion),
   N warm backends per machine.

Decisions already made (user-confirmed 2026-07-02):

- **Zero pilot: keep, fenced behind its flag** (no deletion, no further
  investment; the in-house stack is the committed direction).
- **A1 scope: minimal subset first** (single-table selects incl. 1:1 views +
  simple FK joins; arbitrary loaders remain the escape hatch).
- **Deployment model: one equin instance per user** — recorded as an
  architectural decision; the marketplace shares plugins, not runtime.
- **Tracking: file large-scope tasks** after plan approval.

Key facts from exploration that shaped the design:

- There are **73 resource definitions** (docs said ~42): 39 SIMPLE-SELECT,
  5 JOIN, 7 VIEW-BACKED, 1 AGGREGATE, 15 NON-SQL, 6 COMPLEX → **~51/73
  (70%) are SQL-shaped** and coverable by a minimal builder.
- Only **3 resources** carry hand-written `affectedMap`/`signature`
  (`attemptsResource`, `tasksResource`, `agentLaunchesResource`) — all in
  the keyed + boot-critical tasks/attempts/conversations/agents cascade. So
  A1's payoff is: 39 loaders become declarative one-liners, the one heavy
  cascade becomes derived, and scoped delivery extends to ~48 resources that
  today FULL-recompute on every covered write.
- The eager-tier codegen is feasible on existing machinery: the
  contributions facet already statically parses `contributions: [...]`
  blocks; `web.generated.ts` codegen already infers a dependency graph from
  imports. Exactly one case is statically undetectable (bare side-effect
  `resourceDescriptor()` registration) and needs a marker convention.
- The server resource runtime is already testable with fakes
  (`runtime.test.ts`, 903 lines, proves the pattern); the client transport
  stack has **no seams** — `SharedWebSocket`/`CrossTabElection` construct
  `WebSocket`/`BroadcastChannel`/`navigator.locks` directly.

---

## Track 1 — A1: declarative query-resource primitive (the keystone)

**Goal**: one declaration derives the loader, the scoped loader,
`identityTable`/`coveredOrigins`, and cross-table `affectedMap`s — making
scoping correct *by construction* for the SQL-shaped 70%.

**Design (full detail from the design pass, summarized):**

- **A1 is a pure front-end compiler** emitting
  `ServerResourceOptions<T,P> & ScopePolicy` — the object the existing
  two-arg `defineResource(descriptor, serverOpts)` already accepts.
  **Milestones 1–4 require zero changes to `resource-runtime`.** Descriptors,
  `bootCritical` declarations, and all `useResource` call sites are
  untouched.
- **New plugin `plugins/infra/plugins/query-resource/`** (sibling of
  `entities`). It cannot live in `resource-runtime` — that plugin is
  deliberately drizzle-free/acyclic; A1 needs `drizzle-orm` +
  `@plugins/database/server`. Legal leaf edges only.
  - `core/index.ts` (web-safe): `queryResourceDescriptor(key, fields, pk)` →
    a `KeyedResourceContract` whose `keyOf` derives from the same
    `FieldsRecord` as the server pk — client/server keyed-ness single-sourced.
  - `server/index.ts`: `queryResource(spec)` + `rel(...)`.
- **The declaration is a constrained builder over drizzle refs**, not a new
  DSL: `from: Entity | PgTable | PgView` (+ explicit `identity`/pk for plain
  tables and views), `select?`, `where?`/`orderBy?` as plain drizzle
  fragments, `edges?: rel(upstreamResource, upstreamTable, {fk, upstreamPk},
  {signature?})[]`. Row types fall out of `$inferSelect`.
- **Derivation**: `identityTable` from the identity entity's table name
  (asserted resolvable on 1:1 views, loud throw otherwise); scoped loader =
  the same query with `AND pk IN (affectedIds)`; each `rel()` emits exactly
  the `selectDistinct(fk).where(inArray(upstreamPk, ids))` closure that is
  hand-written today. `signature` relevance gates stay optional and
  hand-authored in v1 (deriving them is the later A3 read-set work).
- **M5 (only runtime change, opt-in `scopedMembership`)**: row-level
  INSERT/DELETE membership for keyed table-scans — DELETE ships
  `{deletes:[id]}` with no loader run; INSERT runs the scoped loader for the
  new id plus a cheap ids-only order query. Ships as 5a (DELETE, low risk)
  then 5b (INSERT). Default-off = byte-identical to today.

**Migration order — trivial selects first, cascade last** (de-risks the
compiler before touching the load-bearing path):

| Milestone | Scope | Runtime change |
|---|---|---|
| M1 | Build the plugin + bun:tests proving derived loader/identityTable/keyOf reproduce hand-written equivalents | none |
| M2 | Migrate 3–5 trivial push resources (tasks-auto-start, conversation-progress, …) to A1 keyed | none |
| M3 | Sweep the remaining ~34 SIMPLE-SELECTs | none |
| M4 | Tasks cascade **edges only**: `rel()` replaces attempts' two + tasks' one affectedMap; tasksResource becomes fully declarative (nested attempts loader stays hand-written) | none |
| M5 | Opt-in scoped membership (5a DELETE, 5b INSERT) enabled on the conversation scans | contained (runtime + keyed-diff) |

**Deleted/unified by this track**:

- ~39 hand-written loader closures + projections + `mode:"push"` lines +
  hand-authored `identityTable` strings.
- `attemptsResource`'s two `affectedMap` closures
  (`plugins/tasks/plugins/tasks-core/server/internal/resources.ts:113-136`),
  `tasksResource`'s `affectedMap` + entire loader body (incl. the
  `satisfies Record<keyof TaskListItem>` drift guard, subsumed by the
  projection type constraint).
- The stale "~42 resources" doc comment; keyed-ness single-sourcing
  boilerplate.
- **Kept as documented escape hatches**: `conversationsGoneResource`'s FULL
  opt-out (LIMIT-30 window), the aggregate/NON-SQL/COMPLEX 30%.

**Critical files**: `plugins/framework/plugins/resource-runtime/core/runtime.ts`
(read-only until M5), `plugins/framework/plugins/resource-runtime/core/keyed-diff.ts`
(M5), `plugins/tasks/plugins/tasks-core/{core,server/internal}/resources.ts`,
`plugins/conversations/plugins/agents/server/` (agentLaunches),
`plugins/infra/plugins/entities/` (Entity metadata),
`plugins/primitives/plugins/data-view/plugins/server-query/` (sibling
precedent; share operator compilation later, not in v1).

**Open questions carried into implementation**: (a) build-time check vs
single-call emission for descriptor/entity pk agreement; (b) view-extended
projections (tasks' status/active SQL exprs) — modeled as Entity-like view
schema objects in M4; (c) composite-PK tables get loader derivation but stay
push-mode.

---

## Track 2 — Sync-engine decision: freeze and fence the Zero pilot

**Goal**: end the two-engines ambiguity without deleting optionality.

- Write the decision into `plugins/database/plugins/zero/CLAUDE.md`:
  **frozen pilot** — kept behind `SINGULARITY_ZERO_CACHE` (already inert by
  default; the gateway 404s `/zero/*` when disabled), receives no feature
  work; the committed direction is the in-house stack (this plan). Cross-link
  the vision doc and this plan.
- Verify the fence is complete: pilot code must impose zero cost when
  disabled (no sidecar spawn, no slot-sweep churn beyond the no-op job tick,
  no build-time coupling). The `debug/zero-test` pane stays (it's the pilot's
  harness) but is marked frozen with it.
- Explicitly **defer** (do not do): removing `wal_level=logical` /
  `listen_addresses` GUCs — they're postmaster-start-only settings whose
  removal would complicate a future un-freeze for marginal benefit.
- Record the re-evaluation trigger: revisit only if/when the vision's B-axis
  (client-side store) becomes a committed track — at which point Zero is
  re-compared against building B1–B3 on the in-house delta transport.

**Deleted/unified**: nothing deleted; one decision recorded, roadmap
ambiguity removed.

---

## Track 3 — Invariant test harness for the live-state core

**Goal**: concentrate the correctness argument (currently spread across
research docs + manual checks) into executable tests; prerequisite
protection for Track 1's M4/M5.

Two halves with different starting points:

**3a — Server runtime (pattern exists, extend it).**
`plugins/framework/plugins/resource-runtime/core/runtime.test.ts` already
constructs runtimes with fake hooks + fake `ws.send`. Add the missing
invariant tests:

- H5: race a `notify()` against a fresh `sub` (the v3 doc's explicit
  prescription — currently only adjacent coverage).
- Catch-up ordering: L2 catch-up replay after LISTEN establishment;
  over-replay idempotence (double-delivery of the same change is harmless).
- Scoped-vs-FULL routing table: covered-origin scoping, sticky-FULL merge
  (`mergePending` null-absorption), empty-scoped-set no-op (no version bump,
  no cascade).
- M5 membership diffs (fuzz `diffKeyedScopedMembership` alongside the
  existing keyed-diff property tests).

**3b — Client transport (seams first, then tests).**
`SharedWebSocket`/`CrossTabElection`/`NotificationsClient` construct
`WebSocket`/`BroadcastChannel`/`navigator.locks` directly — no injection
points, zero tests, and no fakes exist anywhere in the repo. Work:

1. Seam refactor: `CrossTabElection` and `SharedWebSocket` accept injected
   factories (`makeWebSocket`, `makeBroadcastChannel`, `locks`), defaulting
   to the globals — mirroring how `createResourceRuntime` takes injected
   hooks. `NotificationsClient` gains a test-only channel factory parameter.
   No behavior change; production call sites unchanged.
2. Fakes: a deterministic `FakeWebSocket` (scripted server frames),
   `FakeBroadcastChannel` (in-process bus), fake locks (manual grant/steal) —
   in the networking plugin's `web/__tests__/` support, registered patterns
   for reuse.
3. Hazard tests (vitest, jsdom): H1 (frames during reopen gap → resubscribe
   converges), H2 (server restart → all subs converge, versions reset
   handled), H4 (mount/unmount ×10 → exactly one net sub/unsub; keep-alive
   timer honored), H6 (leader dies → follower steals, resubs, invalidates;
   exactly one "real" socket), H7 (level-state convergence after external
   kill), plus the `no-sub` frame-drop gate and delta-no-base → resub.

**Critical files**:
`plugins/primitives/plugins/networking/web/{cross-tab-election,shared-websocket}.ts`,
`plugins/primitives/plugins/live-state/web/notifications-client.ts`,
`plugins/framework/plugins/resource-runtime/core/runtime.test.ts`,
root `vitest.config.ts` + `test/setup.ts` (fakes wiring).

**Deleted/unified**: the H1–H7 manual-check section of the v3 doc gets a
pointer to the tests as the living source of truth.

---

## Track 4 — Codegen the eager tier (kill the allowlists)

**Goal**: replace `DEFERRABLE_APPS`/`EAGER_EXCEPTIONS`
(`plugins/framework/plugins/web-sdk/core/load-tiers.ts`) with a generated
must-be-eager set derived from declared markers — making every app
deferrable by default and the twice-broken bug class unrepresentable.

Mechanism (all substrate exists):

1. **Widen the contributions facet** (`plugins/plugin-meta/plugins/facets/plugins/contributions/`)
   to also parse `server/index.ts` contribution blocks, and query it for a
   watched-slot list: `Core.Root`, `Core.Boot`, `ConfigV2.WebRegister`, and
   `Resource.Declare(..., { bootCritical: true })`.
2. **Close the one detection gap** with a marker convention: bare
   side-effect `resourceDescriptor()` registrations (the release/studio
   case) move to a greppable wrapper (e.g. `bootCriticalDescriptor(...)` in
   live-state core), scanned like `defineCollectedDir`'s marker pattern.
   Enforced by a check: a server-side `bootCritical: true` whose client
   descriptor module isn't marked fails the build (this is the structural
   fix for the class of bug commit `146da4a80` patched).
3. **Transitive closure** over the already-generated `dependsOn` import
   graph (`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`):
   any web entry flagged by (1)/(2), plus everything it transitively
   imports, is eager; everything else under `apps/plugins/*/plugins/*`
   (except each app's `shell`) is deferred.
4. Emit the marker set into the generated registry (alongside
   `web.generated.ts`), consumed by `partitionWebEntries`; add an
   `eager-tier-in-sync` drift check.

**Deleted/unified**: the `DEFERRABLE_APPS` and `EAGER_EXCEPTIONS` sets and
their maintenance burden; the load-tiers header-comment TODO; sonata/mail
special cases become derived facts.

**Verification**: generated set ⊇ current hand-set (diff them in CI before
flipping); boot a cold deep link into each app and confirm first paint +
hydration (boot-profile pane); the release/studio descriptor case
specifically.

---

## Track 5 — ADR: one instance per user

**Goal**: convert the implicit single-user architecture into an explicit,
sanctioned decision with a bounded future-work surface.

- Write `research/2026-07-02-global-adr-single-instance-per-user.md` (small,
  decision-record style): the marketplace shares **plugins**, not runtime;
  each user runs their own instance; multi-device access = authenticated
  gateway to your own instance; **multi-tenancy is a non-goal**. Enumerate
  the couplings this sanctions (trust-auth PG, per-worktree forks, localhost
  subdomains, per-origin leader election, secrets on one host).
- Minimal hygiene so the boundary stays crisp:
  - Add the (deferred-since-v3) `authorize` field to the resource
    subscription path as a typed no-op stub — the seam exists, single-user
    stays the implementation.
  - Note gateway session-auth + TLS as the *only* future multi-device work
    item (not scheduled here).
- Link the ADR from `CLAUDE.md`'s architecture section and the audit's
  gaps list.

**Deleted/unified**: the open-ended "what about multi-user?" question; future
proposals must either fit the ADR or explicitly supersede it.

---

## Track 6 — Write-path scaling (symptom-gated, not scheduled)

**Goal**: pre-agreed designs for the three known ceilings, executed only
when their trigger metrics fire (measured via existing surfaces: runtime
profiler, health-monitor, boot-bench, queue-health).

1. **A4 — hoist keyed diffing above the socket loop**: compute each delta
   once per (key, params) and broadcast, instead of per-subscriber
   `subCounts` work. Trigger: push/flush spans showing per-subscriber diff
   cost on hot resources with >3 concurrent subscribers.
2. **Template-DB forks**: replace live `pg_dump | pg_restore` with fork-from-
   a-periodically-refreshed template database (a scheduled job maintains the
   template; forks become near-instant `CREATE DATABASE ... TEMPLATE`).
   Deletes the hardcoded mail-table exclusion list in
   `plugins/database/plugins/admin/server/internal/fork.ts`. Trigger: fork
   p50 exceeding ~15s or the next fork-interruption incident.
3. **Idle-stop worktree backends**: extend the gateway's existing
   lazy-spawn/idle-sweep to aggressively stop idle backends (the spec +
   cold-start path already exist). Trigger: host memory/load pressure in
   health-monitor with >N warm backends.

---

## Sequencing & dependencies

```
T2 (Zero fence)      — immediate, doc-only, no dependencies
T5 (ADR)             — immediate, doc-only (+ authorize stub)
T3a (server tests)   — immediate; T3b (seams+client tests) next
T1 M1–M3             — after T3a exists (compiler proven against tests)
T1 M4–M5             — after T3a+3b (cascade migration under harness protection)
T4 (eager codegen)   — independent; any time
T6                   — gated on trigger metrics, design pre-agreed here
```

## Task breakdown (to file via `add_task` after approval)

1. **Freeze & fence Zero pilot + write single-instance ADR** (T2+T5 — both
   doc-heavy, one task).
2. **Live-state invariant harness — server half** (T3a).
3. **Live-state invariant harness — client seams + fakes + hazard tests** (T3b).
4. **A1 query-resource primitive: build + trivial migrations** (T1 M1–M3).
5. **A1: tasks/agents cascade migration** (T1 M4).
6. **A1: opt-in scoped membership** (T1 M5, 5a then 5b).
7. **Eager-tier codegen + marker convention + drift check** (T4).
8. **(backlog, symptom-gated)** A4 diff hoisting; template forks; idle-stop
   (T6 — one placeholder task each, bodies reference this doc's triggers).

## Verification (end-to-end, per the repo's testing rules)

- Every track lands with `./equin build` + `./equin check` green.
- T1: after each milestone, the Debug → Read-set pane must show
  coveredOrigins == captured read-set for migrated resources; drive a real
  mutation end-to-end (edit a task/conversation in the UI) and confirm one
  scoped keyed frame on the wire (live-state-health pane / `_debug`
  endpoint), no new no-op pushes (churn monitor quiet); boot-snapshot still
  hydrates all boot-critical keys (boot-profile pane).
- T3: `bun test plugins/framework/plugins/resource-runtime` and
  `bun run test:dom plugins/primitives/plugins/networking
  plugins/primitives/plugins/live-state` run the harness; H1–H7 each map to
  a named test.
- T4: generated eager set diffed against the current hand-set before the
  flip; cold deep-link boot into every app verified via the boot profiler;
  `benchmark_boot` MCP tool for before/after regression numbers.
- T6 items: before/after numbers from the same profiler surfaces that
  triggered them.
