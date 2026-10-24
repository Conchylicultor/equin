# Graph-ordered `onReadyBlocking` — close the migrations-vs-change-feed boot race

## Context

The server runs plugin lifecycle phases in `plugins/framework/plugins/server-core/bin/index.ts`:

| Phase | Ordering today |
| --- | --- |
| `register` | sequential, topo-sorted by `dependsOn` |
| `onReadyBlocking` (lines 263-283) | **flat `Promise.all` — NO ordering** |
| `onReady` (lines 293-313) | **graph-driven** — each plugin waits for its `dependsOn` parents |
| `onAllReady` (lines 321-334) | flat barrier after all `onReady` |

The `database` plugin runs migrations in its `onReadyBlocking` (`awaitDbReady → warmPool → runMigrations → rebuildDerivedViews`). The `change-feed` plugin's `onReadyBlocking` calls `rebuildTriggers(db)`, which enumerates live tables from `pg_stat_user_tables` and installs Postgres triggers. Because `onReadyBlocking` is unordered, on a **truly fresh (non-forked) DB** `rebuildTriggers` can run before migrations have created the tables — so triggers silently never get installed for those tables.

Today this is latent: worktrees fork an already-migrated DB, so the tables exist. `live-state-snapshot` already works around the gap by explicitly `await migrationsReady` (an exported promise) inside its `onReadyBlocking`. But that workaround is itself the footgun — every future DB-touching `onReadyBlocking` must remember it, and the underlying ordering gap remains.

**Root cause:** an asymmetry. `onReady` gates on `dependsOn`; `onReadyBlocking` does not. Yet `dependsOn` edges are auto-derived from static `@plugins/...` imports, and you **cannot do DB work without importing the `database` barrel** (`db`). So every DB-touching plugin already has a `dependsOn` edge to `database` — the ordering information exists; the blocking phase just ignores it.

**Outcome:** make `onReadyBlocking` graph-driven (identical to `onReady`). Every DB-touching plugin's `onReadyBlocking` then auto-sequences after `database`'s (= after migrations), killing the entire class of bug structurally — no per-plugin workaround needed.

## Approach

### 1. Extract a shared `runGraphPhase` helper and use it for both blocking + ready phases

In `plugins/framework/plugins/server-core/bin/index.ts`, the `onReadyBlocking` (263-283) and `onReady` (293-313) bodies become identical except for the hook name and profiler id-prefix. Extract one helper (place it near the top of the file or in a small `bin/` module):

```ts
async function runGraphPhase(
  ordered: LoadedServerPlugin[],
  hook: "onReadyBlocking" | "onReady", // doubles as PhaseId + span id-prefix
): Promise<void> {
  const resolved = new Map<string, Promise<void>>();
  for (const p of ordered) {
    const deps = (p.dependsOn ?? []).map((d) => resolved.get(d.id)!);
    const ready = Promise.all(deps).then(async () => {
      const fn = p[hook];
      if (!fn) return;
      const end = profilerStart(`${hook}:${p.id}`, hook, p.id, p.id);
      try {
        await fn.call(p);
      } catch (err) {
        console.error(`[plugin.${p.id}] ${hook} failed`, err);
        if (p.loadBearing) throw err; // loadBearing rejection aborts boot
      } finally {
        end();
      }
    });
    resolved.set(p.id, ready);
  }
  await Promise.all(resolved.values());
}
```

**Critical:** the per-plugin `try/catch` must stay **inside** the `.then` callback (exactly as `onReady` does today at lines 300-308). A non-loadBearing failure is caught → its promise *resolves* → dependents still proceed, matching today's independent-parallel outcome. Only a `loadBearing` rejection re-throws → its promise rejects → dependents skip → final `Promise.all` throws → boot aborts.

Call sites — keep the outer "Blocking Ready" span, the memory checkpoints, and `markServerReady()` **outside** the helper (they are phase-boundary concerns; `onReady` has no outer span):

```ts
// ── onReadyBlocking ──
{
  const end = profilerStart("onReadyBlocking", "onReadyBlocking", "Blocking Ready");
  try {
    await runGraphPhase(ordered, "onReadyBlocking");
  } finally {
    end();
  }
}
recordMemoryCheckpoint("after-onReadyBlocking");
markServerReady();           // MUST stay between the two phases (gateway hot-swap gate)

// ── onReady ──
await runGraphPhase(ordered, "onReady");
recordMemoryCheckpoint("after-onReady");
```

`onAllReady` (flat barrier) and `register` (sequential) are unchanged.

### 2. Update the `onReadyBlocking` JSDoc

In `plugins/framework/plugins/server-core/core/types.ts` (lines 83-94), the doc says hooks "run in parallel". Update it: `onReadyBlocking` now runs **graph-driven by `dependsOn`, exactly like `onReady`** — a plugin's blocking hook starts only after all its `dependsOn` parents' blocking hooks resolve; the whole phase is still a hard barrier before `markServerReady()`. Mirror the wording already used for the `onReady` phase comment (bin/index.ts:288-292).

### 3. Simplify `live-state-snapshot` (its workaround is now redundant)

In `plugins/database/plugins/live-state-snapshot/server/index.ts`:
- `onReadyBlocking` (lines 42-58): remove `await awaitDbReady()` (line 43) and `await migrationsReady` (line 44). The plugin `dependsOn` `database` and `change-feed`, so under graph-ordering its blocking hook already runs after `database`'s (which awaits both `awaitDbReady` and `runMigrations`).
- Rewrite the now-false comment (lines 33-41) that says "`onReadyBlocking` hooks run in PARALLEL" — state instead that ordering is guaranteed by the `dependsOn` edge to `database`.
- Drop the now-unused imports: `awaitDbReady` (from `@plugins/database/server`, keep `db`) and `migrationsReady` (from `@plugins/database/plugins/migrations/server`).

**Watch the auto-derived `dependsOn` after removing the `migrationsReady` import:** codegen derives edges from static imports, so dropping that import removes the `database/migrations` edge from live-state-snapshot's `dependsOn`. Ordering is still preserved — live-state-snapshot still imports `db` (→ `database` edge) and `routeChange` (→ `change-feed` edge), and `change-feed` itself orders after migrations. After the edit, run `./equin build` and re-verify the regenerated `server.generated.ts`; the `plugins-registry-in-sync` / `plugins-doc-in-sync` checks will flag drift if anything is off.

`migrationsReady` then has no remaining `onReadyBlocking` consumer. Leave the export + resolve/reject plumbing in `runner.ts` in place (harmless, still settled by `runMigrations`); a follow-up could remove it, but that's out of scope here.

### Out of scope (explicitly not doing)
- `to_regclass` guards in `triggers.ts` (`singleColumnPk` / `warnOnCoverageGaps`). The ordering fix removes the fresh-DB race; the remaining TOCTOU (a table dropped mid-rebuild) is a separate, much rarer concern and per "fail loudly" is acceptable to leave surfacing.

## Critical files

- `plugins/framework/plugins/server-core/bin/index.ts` — extract `runGraphPhase`; use for both phases (lines 263-313).
- `plugins/framework/plugins/server-core/core/types.ts` — update `onReadyBlocking` JSDoc (lines 83-94).
- `plugins/database/plugins/live-state-snapshot/server/index.ts` — drop redundant `awaitDbReady`/`migrationsReady`, fix comment, drop imports (lines 1-58).
- `plugins/framework/plugins/server-core/core/profiler.ts` — `profilerStart(id, phase, label, plugin?)` signature (lines 60-65); confirms the helper's 4-arg per-plugin span is correct.
- `plugins/framework/plugins/server-core/bin/topo.ts` — `topoSortPlugins` already produces `ordered` and throws on cycles; reused as-is.
- `plugins/framework/plugins/server-core/core/server.generated.ts` — the `dependsOn` graph to re-verify after the import change.

## Why this is safe (validated)

- Only **4 plugins** define `onReadyBlocking`: `database`, `change-feed`, `live-state-snapshot`, `config_v2`.
  - `database` (loadBearing) depends only on `migrations`/`derived-views`/`runtime-profiler`/`log-channels`, none of which define `onReadyBlocking` → it remains effectively the root, runs first. Unchanged.
  - `change-feed` gains a wait on `database` → runs after migrations. **This is the fix.**
  - `live-state-snapshot` gains waits on `database` + `change-feed` → its `await migrationsReady` becomes redundant.
  - `config_v2` has **no** `database` edge (pure-filesystem `initRegistry`) → keeps full concurrency with `database`. Correct and desirable.
- No new graph edges are introduced; `dependsOn` is already a DAG (drives `register` + `onReady`, `topoSortPlugins` throws on cycles). No deadlock risk.
- Error semantics preserved by keeping the `try/catch` inside the `.then` (mirrors `onReady`).
- `markServerReady()` stays at the phase boundary (gateway gates its hot-swap on `/api/health/ready` flipping after the blocking barrier).
- Concurrency cost is negligible: on the common forked-DB path migrations no-op, so serializing `change-feed` after `database` adds near-zero. Profiler will show `change-feed`/`live-state-snapshot` blocking spans starting later — that's accurate dependency-wait attribution, not a regression.

## Verification

1. **Build clean:** `./equin build` from the worktree. Confirm the server boots and reports ready (gateway serves `http://<worktree>.localhost:9000`). Confirm `plugins-registry-in-sync` and `plugins-doc-in-sync` pass (run `./equin check`).
2. **Ordering in boot profile:** open the Debug → Profiling (Gantt) boot pane, or call the boot-profiling endpoint / `get_runtime_profile` MCP tool. Verify the `onReadyBlocking:database/change-feed` span now starts **at or after** `onReadyBlocking:database` ends (today they start together). Verify `onReadyBlocking:config_v2` still overlaps `database` (no edge).
3. **Triggers present:** via `query_db`, confirm change-feed triggers exist on a representative table, e.g.
   `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.conversations'::regclass AND NOT tgisinternal;`
   (expect the three `live_state_*` triggers).
4. **Fresh-DB scenario (the actual bug):** drop the worktree DB and create a *truly empty* one (not a fork), point the worktree at it, and boot:
   ```bash
   psql -d postgres -c 'DROP DATABASE IF EXISTS "<worktree>" WITH (FORCE)'
   psql -d postgres -c 'CREATE DATABASE "<worktree>"'   # empty, no __singularity_migrations
   ./equin build
   ```
   Confirm boot succeeds, migrations create the tables, and the trigger query in step 3 returns the triggers (proving `rebuildTriggers` ran *after* migrations). Re-fork afterward if needed (`DROP DATABASE` + `./equin build`).
5. **Regression on live-state:** confirm a live resource still updates in the UI (e.g. create a task and watch the list update) — exercises the change-feed LISTEN path + live-state-snapshot catch-up end-to-end.
