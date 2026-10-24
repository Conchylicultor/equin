# Scoped recompute, made correct & default (L1 universal)

> **Category:** global (resource-runtime, database/change-feed, derived-views, tasks, conversations/agents)
> **Status:** design / plan (no code yet)
> **Parent vision:** [`2026-06-19-global-live-state-sync-engine.md`](./2026-06-19-global-live-state-sync-engine.md) §6 L1 ("make scoped recompute universal"), Phasing step 4.
> **Sibling (co-design):** work-admission scheduler "scope mandatory" lever — worktree `att-1781872031-6620` (not yet landed; see Follow-ups).

## 1. Context

A single conversation status change (the poller fires these constantly) currently
forces a **FULL rebuild** of the entire `conversations` aggregate **and** every
downstream resource — `attempts`, `tasks`, `agent-launches`. This is the main
driver of live-state cascade amplification.

The Layer-2 scoped-recompute mechanism (`affectedIds` → `WHERE id IN (…)`,
`affectedMap`, keyed delta) exists in the runtime, and `attemptsResource` /
`tasksResource` even *declare* `affectedMap` edges. But investigation shows those
edges are **dead code today** — scoped recompute never actually fires for this
cascade. Two structural blockers:

1. **View-fanout → FULL.** Every live resource reads a derived **view**
   (`conversations_v`, `attempts_v`, `tasks_v`). The read-set capture records the
   *view* name (`client.ts:86` `extractTablesFromSql`), and the change-feed
   expands a base-table change onto its dependent views as a **FULL**
   invalidation (`listener.ts:96-100`: *"a view's row identity is not guaranteed
   to match the base PK"*). So a scoped `_conversations` UPDATE never reaches a
   `conversations_v`-reader as scoped — it always arrives FULL.

2. **Key-space corruption (the subtle one).** `applyDbChange`
   (`runtime.ts:1390`) delivers a table's **raw row-ids** as `ctx.affectedIds`
   to *every* resource whose read-set includes that table. But `attemptsResource`
   reads `conversations_v` directly (for conversation summaries) while being
   keyed by `attempts.id`. If we naively scope the view fanout, attempts' loader
   would receive **conversation-ids** and run `WHERE attempts.id IN (convIds)` —
   wrong/empty results. This bug is *masked today* only because everything is
   FULL. Scoping safely requires the runtime to deliver scoped ids **only in each
   resource's own key space**.

**Outcome wanted:** a single-row change recomputes only the affected keys across
the whole `conversations → attempts → tasks` + `agent-launches` cascade; scoped
is the default-when-safe with FULL as an always-correct fallback; and the path is
structured so the work-admission scheduler can later *enforce* "must be scoped"
on top of this same substrate (one policy, not two).

## 2. The unifying principle

> **An `affectedMap` edge (with its transitive identity coverage) takes
> precedence over a read-set / view-fanout match for the same originating base
> table.**

Every change carries its **origin base table** `B`. For a resource `R` reading
the changed table/view:

- `B == identity(R)` → **scoped** delivery (the ids are in R's key space).
- `B ∈ coveredOrigins(R) \ {identity(R)}` → **suppress** (an `affectedMap` edge
  already delivers this change, correctly translated & scoped).
- otherwise → **FULL** (an uncovered dependency; safe coarse fallback —
  unchanged from today).

Where:
- `identity(R)` = the base table whose PK equals `R`'s `keyOf` id (declared).
- `coveredOrigins(R) = {identity(R)} ∪ ⋃_{edge e of R} coveredOrigins(e.resource)`
  (transitive closure over `affectedMap` edges).

This single rule fixes **both** blockers: identity-table changes scope (blocker
1, via view forwarding below), and non-identity reads covered by an edge are
suppressed instead of corrupting or FULL-absorbing (blocker 2).

### Worked example — one `_conversations` UPDATE

`routeChange(_conversations, ids=[c1])` fans out (every change tagged
`origin=_conversations`):

| target view | identity | decision for its readers |
|---|---|---|
| `conversations_v` | `_conversations` | **scoped** to `conversationsLive` (id match → propagates `[c1]`); **suppressed** for `attempts` & `agent-launches` (edge-covered) |
| `attempts_v` | `_attempts` | **suppressed** for `attempts` (`_conversations ∈ coveredOrigins`); scoped path arrives via the edge |
| `tasks_v` | `_tasks` | **suppressed** for `tasks` (`_conversations` covered transitively through attempts) |

Result: `conversationsLive` propagates `[c1]` → `attempts.affectedMap([c1])` →
`{a1}` (scoped) → `tasks.affectedMap([a1])` → `{t1}` (scoped); `agent-launches`
`affectedMap([c1])` → `{l1}` (scoped). **No FULL rebuild anywhere.** A `pushes`
change (no edge) still FULLs attempts/tasks — correct fallback (rare).

## 3. Changes

### A. View identity-table forwarding (change-feed)

1. **`plugins/database/plugins/derived-views/server/internal/contribution.ts`** —
   extend the `View` contribution: add optional `identityTable?: string` (the
   base table whose PK == the view's row id). True for our three views
   (1:1 PK-preserving joins):
   - `conversations_v` → `_conversations`
   - `attempts_v` → `_attempts`
   - `tasks_v` → `_tasks`

2. **`plugins/tasks/plugins/tasks-core/server/index.ts`** — declare
   `identityTable` on `View({ view: conversations | attempts | tasks })`.

3. **`plugins/database/plugins/change-feed/server/internal/view-deps.ts`** —
   build a `view → identityBase` map from `View.getContributions()` (mirror how
   `rebuild.ts` reads them); expose `viewIdentityBase(view)`.

4. **`…/change-feed/server/internal/listener.ts` `routeChange`** — when expanding
   a base change `B` onto dependent view `V`: if `B === viewIdentityBase(V)`,
   forward **scoped** (`{table: V, op: change.op, ids: change.ids, origin: B}`);
   else forward FULL (`{table: V, op: "U", ids: null, origin: B}`). Tag the
   direct base apply with `origin: B` too. (`op !== "U"` still degrades to FULL
   inside `applyDbChange`, so INSERT/DELETE membership changes stay FULL.)

### B. Identity-aware, edge-suppressed scoping (runtime — load-bearing)

`plugins/framework/plugins/resource-runtime/core/runtime.ts`:

5. `ResourceDefinition` + `RegistryEntry` gain `identityTable?: string`. Surface
   it through the `defineResource` facade in
   `plugins/framework/plugins/server-core/core/resources.ts`.

6. Compute `coveredOrigins(key)` lazily (memoized like `tableToResources`,
   invalidated on the same registry-size/read-set signature): transitive closure
   of `identityTable` over each entry's `downstream`/edge graph. Cheap, recomputed
   only on registry growth.

7. `applyDbChange` gains an `origin: string` field. Per affected resource `R`,
   apply the §2 decision: `origin == identity(R)` → scoped (`affected = Set(ids)`
   for `op === "U"`, else null); `origin ∈ coveredOrigins(R)\{identity(R)}` →
   `continue` (suppress); else → FULL. Replaces today's "every read-set match
   gets the raw scoped ids".

8. Update the re-export of `applyDbChange` and the `listener.ts` call site for the
   new `origin` field. `RecomputeIntent.delta` already carries `table`; leave it.

### C. Resource conversions

9. **`plugins/conversations/plugins/agents/server/internal/resources.ts`** —
   `agentLaunchesResource`:
   - `mode: "keyed"`, `keyOf: (l) => l.id`, `identityTable: "agent_launches"`.
   - `dependsOn: [{ resource: conversationsLiveResource, affectedMap }]` where
     `affectedMap(convIds)` = `convIds → taskIds` (distinct `taskId` from
     `conversations_v WHERE id IN convIds`) → `taskIds → launch ids`
     (`agent_launches WHERE task_id IN taskIds`). Imports
     `conversationsLiveResource` from `@plugins/tasks/plugins/tasks-core/server`
     (agents already imports that barrel — `listConversationsForDisplay`).
   - Loader: when `ctx?.affectedIds`, `WHERE agent_launches.id IN (ids)` and
     compute latest-conversation only for those launches' `taskId`s; return the
     partial array (`diffKeyedScoped` merges by `keyOf`).

10. **`plugins/tasks/plugins/tasks-core/server/internal/resources.ts`** — add
    `identityTable` to `conversationsLiveResource` (`_conversations`),
    `attemptsResource` (`_attempts`), `tasksResource` (`_tasks`). The existing
    `affectedMap` edges are unchanged — they finally fire. `conversationsLive`
    stays `push`: its loader keeps the full 4-query rebuild (bounded payload), but
    it now *propagates* scoped conv-ids downstream — which is what kills the
    cascade amplification.

## 4. Follow-up sub-tasks (tracked via `add_task` on approval)

These are the **clean end states** that are orthogonal to (and larger than)
killing the cascade amplification, so they ship separately:

- **Conversations own-payload incrementality.** `conversationsLiveResource`
  returns an aggregate payload (active/gone lists + counts + system), so it can't
  itself become a keyed/delta resource — this task makes its *cascade* scoped, not
  its *own* wire payload. Clean long-term fix: decompose into keyed array
  sub-resources (`conversations-active`, `conversations-system`, a gone page +
  counts) recombined client-side via `useCombinedResources`, so its own payload
  delta-syncs too. Consumer-facing (touches the sidebar list) → its own task.
- **Scheduler "scope mandatory" enforcement.** This task lands the *source* +
  safe default. The work-admission scheduler (sibling worktree) owns the *policy*:
  a per-resource recompute-policy and a `./equin check` that fails when a
  DB-backed keyed resource lacks `identityTable`/edge coverage (i.e. silently
  falls to FULL). Co-design against this `identityTable`/`affectedMap` substrate.
- **Derive `identityTable` + `affectedMap` from FK metadata** (doc §5 "later
  refinement") — removes the last hand-authored coupling. Optional.

## 5. Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — §B (core).
- `plugins/framework/plugins/server-core/core/resources.ts` — `identityTable` in facade.
- `plugins/database/plugins/derived-views/server/internal/contribution.ts` — `View.identityTable`.
- `plugins/database/plugins/change-feed/server/internal/{view-deps,listener}.ts` — forwarding + origin.
- `plugins/tasks/plugins/tasks-core/server/{index.ts,internal/resources.ts}` — view decls + identity + revived edges.
- `plugins/conversations/plugins/agents/server/internal/resources.ts` — agent-launches → keyed + affectedMap.

## 6. Verification

- **Dormancy baseline:** with current code, mutate one conversation's status
  (`UPDATE _conversations …` via `query_db` is read-only — use the app: send a
  turn / change status) and confirm via `get_runtime_profile kind:"loader"` that
  `attempts`, `tasks`, `agent-launches` each recompute **FULL** (full row counts).
- **Scoped after:** repeat post-change; `get_runtime_profile` shows each
  recomputing **scoped** (one key) — `attempts`/`tasks`/`agent-launches` load a
  single row, not the whole list.
- **Correctness (no key-space corruption):** open Tasks + Agents tabs; drive
  several conversation status changes; confirm the lists stay correct (right
  statuses, no dropped/duplicated rows) — proving scoped ids land in the right key
  space and FULL fallbacks (INSERT/DELETE, `pushes`) still fire.
- **Out-of-process:** `UPDATE` via `psql` → open tabs still update (feed path).
- `./equin build` and `./equin check` pass.
