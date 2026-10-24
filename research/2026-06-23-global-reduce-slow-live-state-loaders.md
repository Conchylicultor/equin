# Reduce the slow `attempts` live-state loader

## Context

After the L4 change-feed churn fix, the remaining app-slowness source is a few expensive
live-state loaders. This plan covers **only `attempts`** (the `review.plugin-changes` work is
deferred — separate effort).

Why `attempts`: runtime profiling on `main` shows it is the single most expensive loader by
real work (~2.8s `workMs` in a contended window) and its slow delivery drags
`deliver:attempts` / `deliver:tasks` to ~22s — the "tens of seconds push latency" symptom.

### Root cause — confirmed (not hypothesis)

`attempts` is declared **boot-critical**
(`plugins/tasks/plugins/tasks-core/server/index.ts:182`):

```ts
Resource.Declare(attemptsResource, { bootCritical: true })
```

A boot-critical, DB-backed resource is **persisted** (`bootCritical && !externalSource`,
`live-state-snapshot/server/internal/persist.ts`). The live-state runtime forces every
persisted resource to **always FULL-recompute**, for live subscribers *and* cold boot —
because a scoped partial can't be written to `live_state_snapshot`:

```
plugins/framework/plugins/resource-runtime/core/runtime.ts:1334
  const scoped = affected !== null && !persisted;   // persisted ⇒ never scoped
```

So `attempts`'s carefully-built scoped path — `identityTable: "attempts"` + the
`conv → attempt` `affectedMap` + the `conversationCascadeSignatures` gate
(`resources.ts:90-152`) — is **dead code**. `ctx.affectedIds` is never set; the loader
always runs its unscoped branch.

**Measured proof** (`get_runtime_profile { kind: "db" }` on `main`):

| query (issued by `attempts` loader) | count | avg | max (under contention) |
|---|---|---|---|
| `attempts_v` full scan (no WHERE) | 3293 | 53 ms | **10558 ms** |
| `conversations_v` full scan (`kind <> $1`, no `attempt_id`) | 3293 | 36 ms | **10279 ms** |
| scoped `… where id in (…)` variant | **0** | — | — |

Every fire (a) scans `attempts_v` — a CTE aggregating **all** `conversations` + `pushes`
(`views.ts:31-83`), (b) scans the full `conversations_v` join for per-attempt summaries
(`queries/conversations.ts` `listConversationSummariesByAttempt`), and (c) builds 3024
`AttemptWithConversations` objects in JS. Baseline ≈ 90 ms of SQL; under flush contention the
*same* FULL queries balloon to 8–10 s (there is a 94 s `flushNotifies` in the window). The
cost = **always-FULL × high fire frequency × contention amplification**.

Note: this is a **class** problem — every boot-critical resource (`tasks`,
`conversations-active/gone/categories`, `pushes`, …) is always-FULL for the same reason. They
look fast only because their FULL queries are cheap (1–3 ms); `attempts`'s FULL is expensive.

Intended outcome: cut `attempts`'s per-fire cost so it stops dominating flush time and push
latency (and stops inflating system-wide DB contention that makes the cheap loaders queue).

---

## Two fix paths

Because persisted ⇒ always-FULL is **by design** (the L2 snapshot must hold a complete
value), there are two levers. They are not mutually exclusive; path B subsumes A.

### Path A — make the FULL recompute cheap (tactical, in-scope, low risk)

Apply the proven `DerivedTable` incremental-rollup pattern (just landed for `agent-launches`,
commit `54097e4a1`) to `attempts`. Replace the expensive `attempts_v` CTE-over-
`conversations`+`pushes` with a **flat, trigger-maintained `attempt_status` rollup table**
(`attempt_id` PK, `status`, `active`, `finished_at`), maintained by STATEMENT triggers on
`conversations` and `pushes`. The loader's FULL `attempts_v` scan (53 ms, CTE) becomes a flat
indexed scan (~3–5 ms) that is far more contention-resilient.

- Pattern reference: `plugins/conversations/plugins/agents/server/internal/rollup-spec.ts`
  + `plugins/database/plugins/derived-tables/` (`DerivedTable` contribution,
  `rebuildDerivedTables`, `feedExemptTables`). Read handle in a **non-glob** file
  (`rollup-table.ts`) so drizzle codegen generates no migration.
- Files: new `rollup-spec.ts` + `rollup-table.ts` under
  `plugins/tasks/plugins/tasks-core/server/internal/`; register `DerivedTable(spec)` in
  `tasks-core/server/index.ts`; rewrite the `attempts_v` read in `resources.ts` /
  `views.ts` to read the rollup.
- **Limitation:** triggers on **two** source tables (`conversations` + `pushes`), not one.
  And it only cuts the `attempts_v` half — the `conversations_v` per-attempt-summaries scan
  (36 ms) and the 3024-row JS nesting remain (both cheaper, but still always-FULL). Expect
  roughly a ~5–10× cut in `attempts`'s DB cost and much better behavior under contention,
  **not** the ~1000× that true scoping would give. Each fire still rebuilds all 3024 rows.

### Path B — make persisted resources maintainable incrementally (structural, higher risk)

The real footgun is the blanket `persisted ⇒ always FULL` rule (`runtime.ts:1334`): it
defeats the scoped-cascade machinery for the *entire* boot-critical class. The clean fix is to
let a persisted resource **apply a scoped delta to its persisted snapshot** instead of
re-deriving the whole value — so `attempts` (and `tasks`, `conversations-*`, …) finally use
their existing `affectedMap` scoped path: recompute 1–2 changed rows per fire, deliver the
keyed delta to subscribers, and patch those rows into the stored `live_state_snapshot.value`
(keeping the `xmin` watermark consistent).

- This benefits every boot-critical resource at once and is the "fix the structural issue,
  not the instance" approach the project prefers.
- **Risk:** it modifies load-bearing live-state-core (`resource-runtime` + `live-state-
  snapshot`) — the persisted-value read-modify-write must stay consistent with the watermark
  and the catch-up replay (`catch-up.ts`), and a torn/partial persist must fail safe to FULL.
  Needs its own design doc and careful review.
- Reference: `research/2026-06-22-global-live-state-l2-persisted-materialization.md` (§3.3,
  §3.6, §6.7 explain why scoped partials are currently never persisted — the constraint this
  path relaxes).

**Recommendation:** start with **Path A** (localized, low-risk, also reduces the system-wide
contention that makes the cheap loaders appear slow). Treat **Path B** as the follow-up
structural fix (separate plan) if Path A's residual always-FULL cost is still material.

---

## Verification

1. `./equin build` in the worktree.
2. `mcp__singularity__get_runtime_profile { kind: "db", worktree: "<wt>" }` — confirm the
   `attempts_v` CTE scan is replaced by a flat rollup scan and per-fire DB cost drops; then
   `{ kind: "loader" }` — `attempts` `workMs` and `{ kind: "push" }` `deliver:attempts` /
   `deliver:tasks` should fall.
3. Tasks app at `http://<wt>.localhost:9000/tasks` — confirm attempt statuses
   (pending/in_progress/pushed/completed/abandoned) and the nested conversation lists still
   render and update live (launch/exit/push a conversation).
4. `./equin check` — boundaries + type-check. `migrations-in-sync` must stay green: the
   rollup table uses a non-glob handle, so no migration is generated (same as agent-launches).

## Notes
- Out of scope (agreed): the general contention / boot-subscribe thundering-herd / connection-
  gate workstream — which is the *actual* cause of the "slow conversation loaders" symptom
  (their FULL queries are 1–3 ms; they're contention victims). Path A reduces that contention
  indirectly by shrinking `attempts`'s connection-hold time.
- `review.plugin-changes` deferred to a separate effort.
</content>
