# Remove hand-`notify()` + hand-drawn `dependsOn`, now that invalidation is DB-derived

> **Category:** global (resource-runtime, server-core, central-core, tasks, conversations, tooling/checks)
> **Status:** plan / approved approach (no code yet)
> **Builds on:** `research/2026-06-19-global-live-state-sync-engine.md` §5, §7, §8 (step 3).
> Prior task landed L3 read-set capture + L4 DB change-feed (`f1cb55dce`).

## 1. Context

Live-state invalidation now has a DB-derived source: statement-level Postgres
triggers `pg_notify('live_state', {table, op, ids})` on every commit, routed
through the L3 read-set index (`table → [resource keys]`) into the recompute
cascade (`applyDbChange` in `resource-runtime/core/runtime.ts`). Triggers cover
**every** public table, and base-table writes fan out to dependent views via
`dependentViews()` (the `view_table_usage` closure).

That makes two things dead weight that can only drift:

1. **~131 hand-called `notify()` on DB-backed resources** — the feed already fires
   them. A surviving necessary one is not a line to keep; it's a **read-set gap**
   (a table the L3 capture missed) to fix at the source.
2. **The "reads table T" `dependsOn` edges** — captured automatically by the
   read-set.

The prior task already shipped the **self-verifying signal** that makes this
migration safe: `scheduleNotify(entry, params, affected, {source})` keeps a 2s
ring buffer matching each hand-`notify` against feed intents for the same
`(resource, paramsKey)`; an unmatched hand-notify logs `[live-state] read-set-gap
candidate: …` and the read-set debug pane badges any resource with `hand>0 &&
feed===0` red. That is the migration's correctness oracle.

**End state (the API shrinks):**
- `notify()` survives **only** for non-DB sources (git-watcher, file-watcher,
  transcript reads, in-memory registries, secrets API) — the explicit escape hatch.
- `affectedMap` is the **only** authored cross-resource coupling left (the
  upstream-id → downstream-id join the read-set can't infer).
- Hand-`notify` on a DB-backed resource is made **structurally impossible** (a
  compile error), with a backstop `./equin check`.

## 2. Enforcement: by-construction + backstop check (the chosen approach)

Today `defineResource(def)` returns `Resource<T,P>` whose interface includes
`notify()` (`runtime.ts:156-170`). Both facades re-present it
(`server-core/core/resources.ts:36`, `central-core/core/resources.ts:26`).

**Split the factory so a DB-backed resource has no `notify` to call:**

- In `resource-runtime/core/runtime.ts`:
  - Narrow `interface Resource<T,P>` to `{ key; mode; schema; load() }` — **drop
    `notify`**.
  - Add `interface ExternalResource<T,P> extends Resource<T,P> { notify(params?, opts?): void }`.
  - `ResourceRuntime` gains `defineExternalResource: <T,P>(def) => ExternalResource<T,P>`
    alongside `defineResource: <T,P>(def) => Resource<T,P>`. Both call the same
    internal `createResource` (the runtime object keeps a `notify` method either
    way — only the **returned type** differs); `defineExternalResource` also sets
    `entry.externalSource = true` for the `_debug` payload.
- Re-export `defineExternalResource` + `ExternalResource` from **both** facades
  (`server-core/core/resources.ts` destructure at line 135-146 and type aliases
  at 32-42; `central-core/core/resources.ts:31` + `index.ts`).

Result: `tasksResource.notify()` is a **compile error** (no such method on
`Resource`); only resources declared with `defineExternalResource` expose it.
This is §7's strongest enforcement layer ("by construction"). Blast radius is
small *because* this task deletes all 131 DB-backed notify calls first — after
deletion, no DB resource references `.notify` at all.

**The ~16 escape-hatch resources** that legitimately keep `notify` switch to
`defineExternalResource` (the resources behind the 23 non-DB call sites):
`prototypesResource`, `prototypesVersionResource` (prototypes/files/watcher),
`authStateResource` (auth/central), `frontendHashResource` (build),
`configV2{Server,Tiers,Conflict,Scopes,ConflictPaths,ModifiedCounts}Resource`
(config_v2), `editedFilesResource` (conversation-view/code),
`jsonlEventsResource` (jsonl-viewer), `worktreeOpsResource` (op-status),
`secretMetaServerResource` (fields/secret/config), `refHeadResource`
(git-watcher). Git resources that never call notify (`mainAheadCount`,
`commitDelta`, `commitsGraph`) stay plain `defineResource` — they invalidate via
their `dependsOn` cascade, not a hand-call.

**Backstop check** — `framework/plugins/tooling/plugins/checks/plugins/no-db-backed-notify/check/index.ts`
(mirrors `no-raw-websocket/check/index.ts`: `grepCode` + `maskSource`,
auto-discovered by the collected-dir loader, no central registry edit). The type
split already blocks honest mistakes; the check closes the one way to subvert it
— marking a DB-backed resource `external`. It scans every `defineExternalResource({…})`
block and **fails if its `loader` body references `db.` (drizzle)**. Guarantee:
to get a callable `notify` you must use `defineExternalResource`, and an external
resource must not read the DB — so a DB-backed resource can never have a live
hand-notify. This is the "single-path spine" shared with the work-admission work:
`externalSource` is one declared classification both the check and a future
admission scheduler read, not two parallel mechanisms.

## 3. The three `affectedMap` survivors / `dependsOn` deletions

Verified against `tasks-core/server/internal/views.ts`: `attempts_v` joins both
`pushes` (the `push_agg` CTE) and `conversations` (`conv_agg`), and `tasks_v`
reads `attempts_v`. So `dependentViews('pushes'|'conversations'|'attempts')`
already routes base-table writes to the downstream resources as FULL.

| Edge | File | Action |
|---|---|---|
| `pushes → attempts` (identity `affectedMap`) | `tasks-core/.../resources.ts:84-89` | **DELETE.** Redundant (`attempts_v` reads `pushes` → feed already reaches `attemptsResource`); identity map is also *wrong* under the feed (feed emits push PKs, not attempt ids); and dead on the insert-only path (`op="I"` → FULL anyway). |
| `conversationsLive → attempts` (real join) | `tasks-core/.../resources.ts:71-83` | **KEEP.** Traced `applyDbChange→scheduleNotify→drainEntry→affectedMap`: a scoped `conversations` write carries conv row-ids as `affected` on conversationsLive's `{}` pk (mode push, no keyOf — `affected` rides the PendingNotify independently of keyed-diff); the join `SELECT DISTINCT attemptId FROM conversations_v WHERE id IN (…)` maps them correctly. |
| `attempts → tasks` (real join) | `tasks-core/.../resources.ts:133-146` | **KEEP.** Same trace; `SELECT DISTINCT taskId FROM attempts_v WHERE id IN (…)`. |
| `conversationsLive → agentLaunches` (identity, no `affectedMap`) | `conversations/.../agents/.../resources.ts:31-33` | **DELETE** (after read-set gate, §4). Loader reads `_agent_launches` + `listConversationsForDisplay()` (conversations); both feed-covered → the always-FULL identity cascade is exactly what the feed reproduces. Also drop the now-unused `conversationsLiveResource` import (line 7). |
| `refHead → mainAhead`; `pushes/refHead → commitDelta`; `pushes/refHead → commitsGraph` | `build/.../main-ahead-resource.ts:10`; `commits-graph/.../resources.ts:65-90` | **KEEP.** Downstream is a git subprocess (no DB read-set), so the feed can never reach it — these cross-source edges are the only link from a DB/git change to the git recompute. |

## 4. Migration of the 131 DB-backed `notify()` — per-table, signal-gated

Driven by the self-verifying oracle; the rule is **fix the read-set gap at the
source, never keep the notify.**

1. **Baseline (no deletions).** `./equin build`, then exercise each domain
   (create/update/delete task, push, conversation, agent launch, song, page
   block, etc.). Read the read-set debug pane. Any resource badged red (`hand>0 &&
   feed===0`), or any `[live-state] read-set-gap candidate` log line, is a table
   the feed doesn't yet cover.
2. **Fix gaps at source.** Typical cause: a loader read that bypassed the
   instrumented `pool.query` chokepoint (raw `sql\`\``), or a missing view→base
   edge. Route the read through the chokepoint / complete the view-deps so the
   feed covers it. Re-exercise until the badge clears (`feed>0`).
3. **Delete per table.** One table at a time (simplest first — `agents`,
   `_agent_launches`; hottest last — `conversations`). Delete the DB-backed
   `notify()` calls for resources backed by that table; confirm the resource still
   updates live and `notifyStats` shows `feed>0, hand===0`. The `pushes` batch
   also removes the `pushes→attempts` edge; the `_agent_launches` batch removes
   the `agentLaunches` edge.
4. **Dead helpers.** Deleting notifies empties some wrapper modules
   (`tasks-core/.../notify-conversations.ts`, `page/editor/.../notify.ts`,
   `notify-structural-change.ts`). Delete the now-empty helpers and their imports
   rather than leaving no-op shells.
5. **Switch escape-hatch resources** to `defineExternalResource` (§2), then land
   the backstop check.

**INSERT/DELETE → FULL scoping regression (accepted interim).** The feed scopes
only `op="U"` with non-null ids; INSERT/DELETE degrade to FULL-for-table. Some
deleted hand-notifies scoped an insert more tightly (e.g. `insertPush` →
`{affectedIds:[attemptId]}`). Post-deletion those become FULL recomputes of the
keyed resource — a **performance**, never a correctness, change (keyed delta-sync
still ships only changed rows to clients; only the server-side recompute widens,
and `attempts_v`/`tasks_v` are written set-at-a-time precisely for this). This is
phasing **step 4 (L1 universal)** in the sync-engine doc — out of scope here.
Mitigation path if a hot table measurably regresses (`loaderStats` in the debug
pane): teach `applyDbChange` to treat `op="I"` as scopable for keyed resources
(the trigger already carries `new_rows` PKs) — a feed enhancement, not this task.

## 5. Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — split `Resource`
  / add `ExternalResource` + `defineExternalResource`; `externalSource` on
  `RegistryEntry` + `_debug` payload.
- `plugins/framework/plugins/server-core/core/resources.ts` /
  `plugins/framework/plugins/central-core/core/resources.ts` (+ `index.ts`) —
  re-export the new factory/type.
- `plugins/tasks/plugins/tasks-core/server/internal/resources.ts` — delete
  `pushes→attempts` edge; keep the two real-join `affectedMap`s.
- `plugins/tasks/plugins/tasks-core/server/internal/mutations/pushes.ts` — delete
  both hand-notifies (40-41).
- `plugins/conversations/plugins/agents/server/internal/resources.ts` — delete
  the `agentLaunches` edge + unused import.
- The ~131 DB-backed `notify()` call sites (full inventory in conversation
  history; grouped by table for §4) + the ~16 escape-hatch resource definitions.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/no-db-backed-notify/check/index.ts`
  — new check (template: `…/no-raw-websocket/check/index.ts`; helper:
  `grepCode` from `checks/core`).

## 6. Verification

- **`./equin build`** type-checks. Removing `notify` from `Resource`
  surfaces any *missed* DB-backed notify as a compile error (a free completeness
  check). Boot log shows `[change-feed] installed live_state triggers …` with no
  missing-trigger warning.
- **Per-table green signal:** for each migrated table, the read-set debug pane
  shows the resource `feed>0` with no red "read-set gap" badge after exercising
  the domain; no `[live-state] read-set-gap candidate` log lines remain.
- **Survivor edges fire:** with a scoped `conversations` UPDATE (e.g. a status
  flip), confirm `attemptsResource` recomputes only the affected attempt (watch
  `loaderStats`/scoped path) → `conversationsLive→attempts` still routes; a status
  change proves `attempts→tasks`.
- **Problem-1 deletions behave:** `insertPush` (notifies + `pushes→attempts` edge
  gone) still flips attempt/task status live (proves `dependentViews('pushes')→
  attempts_v`); create/delete an agent launch (edge gone) still updates
  `agent-launches`.
- **Out-of-process write:** mutate a migrated table via `psql` → open tabs update
  (the feed's reason for existing — a hand-notify never covered this).
- **`./equin check`** passes; the new `no-db-backed-notify` check fails when
  a `defineExternalResource` loader references `db.`, and a deliberately-re-added
  `tasksResource.notify()` fails to compile.
- **Regression bound:** spot-check `loaderStats` for `attempts`/`tasks` after
  deletion; FULL-on-membership widening stays within budget (else trigger the
  step-4 INSERT-scoping enhancement, out of scope).
