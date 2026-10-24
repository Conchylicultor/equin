# Server plugin loading order resolution

## Context

The DB is being extracted into a proper plugin (by a separate agent). Currently `awaitPgReady()` + `runMigrations()` run inline in `server/src/index.ts` between the register phase and the parallel onReady phase. Once DB becomes a plugin with its own `onReady`, its initialization must complete before other plugins' `onReady` hooks run.

**Current boot sequence** (`server/src/index.ts`):
1. `topoSortPlugins(plugins)` — DFS on `dependsOn?`; **currently a no-op** (no plugin declares `dependsOn`)
2. Sequential register pass — each plugin's `Registration[]` tokens run in topo order
3. Inline `await awaitPgReady(); await runMigrations();` — not owned by any plugin
4. `Promise.all(ordered.map(p => p.onReady?.()))` — all 19 onReady hooks run in parallel

**Problem:** Once DB becomes a plugin, steps 3 and 4 must merge. The DB plugin's `onReady` must complete before any other plugin's `onReady` fires.

## Design

Two independent changes that together solve this:

### 1. Auto-derive `dependsOn` from cross-plugin server imports

Modify `cli/src/plugin-registry-gen.ts` to scan each plugin's `server/` directory for cross-plugin imports and emit `dependsOn` assignments in the generated file.

**Input:** The `parseServerApiUses` function in `plugins/plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts` (line 386) already parses `@plugins/<name>/server` imports for each plugin. The `PluginNode.server.apiUses` field carries these as `"<pluginName>.<export>"` strings.

**Generated output:**
```typescript
// plugins.generated.ts (server)
import infraDatabasePlugin from "@plugins/infra/plugins/database/server";
import infraJobsPlugin from "@plugins/infra/plugins/jobs/server";
import conversationsPlugin from "@plugins/conversations/server";
// ...

// Auto-derived from cross-plugin server import edges
infraJobsPlugin.dependsOn = [infraDatabasePlugin];
infraEventsPlugin.dependsOn = [infraJobsPlugin];
conversationsPlugin.dependsOn = [infraDatabasePlugin, infraJobsPlugin, tasksCorePlugin];
// ...

export const plugins: ServerPluginDefinition[] = [...];
```

**Rules:**
- Only `@plugins/X/server` imports count — not `shared`, not `web`
- No special cases needed — when the DB migrates to a plugin, all consumers will import from `@plugins/infra/plugins/database/server` and the graph captures it automatically
- Type-only imports are conservatively counted (over-constraining is safe)
- Cycles: already prevented by `./equin check --plugin-boundaries`

### 2. Eager graph-driven `onReady` execution

Each plugin's `onReady` fires the moment all its direct dependencies have resolved — no artificial layer barriers. A plugin waiting on `database` doesn't also wait for unrelated siblings like `config`.

Replace the parallel `Promise.all` in `server/src/index.ts`:

```typescript
const resolved = new Map<string, Promise<void>>();

for (const p of ordered) {
  const deps = (p.dependsOn ?? []).map(d => resolved.get(d.id)!);
  const ready = Promise.all(deps).then(async () => {
    if (p.onReady) {
      try {
        await p.onReady();
      } catch (err) {
        console.error(`[plugin.${p.id}] onReady failed`, err);
        if (p.loadBearing) throw err;
      }
    }
  });
  resolved.set(p.id, ready);
}

await Promise.all(resolved.values());
```

**How it works:** `topoSortPlugins` guarantees every plugin appears after its dependencies in `ordered`, so `resolved.get(d.id)` is always defined when we reach a plugin. Each plugin gets its own promise that chains on its parents' promises. The final `Promise.all` waits for the entire graph to settle.

**No `topoLayers` needed.** The promise graph naturally provides maximum parallelism — each node starts at the earliest possible moment.

### 3. DB plugin gains `onReady`

`plugins/infra/plugins/database/server/internal/plugin.ts`:
```typescript
const plugin: ServerPluginDefinition = {
  id: "database",
  name: "Database",
  loadBearing: true,
  onReady: async () => {
    await awaitPgReady();
    await runMigrations();
  },
};
```

Remove inline `awaitPgReady()` / `runMigrations()` calls from `server/src/index.ts`.

## Expected execution flow

```
t=0    database.onReady starts (awaitPgReady + migrations)
t=~2s  database resolves → jobs, config, attachments, git-watcher all start immediately
t=~2.1s config resolves (fast) → nothing blocked on it alone
t=~2.1s jobs resolves → events starts immediately (doesn't wait for config/attachments)
t=~2.1s events resolves → conversations, build, tasks start immediately
       (even though attachments/git-watcher may still be running)
```

Each plugin starts at the earliest possible moment — no unnecessary waiting.

## Cost analysis

Today: 2 sequential barriers (register → inline DB → parallel onReady).
After: register → graph-driven onReady (each plugin starts as soon as its parents resolve).

The critical path is: `database` → `jobs` → `events` → feature plugins. Each intermediate step is ~50-100ms. Total overhead on the critical path: **under 200ms** on top of the migration runner. Plugins off the critical path run fully in parallel with no added latency.

## Edge cases

| Case | Handling |
|------|----------|
| Type-only imports | Conservatively counted — over-constraining is safe |
| Plugins without `onReady` | Their promise resolves immediately; dependents proceed without delay |
| `loadBearing` failure | Throws from within the promise; `Promise.all` at the end propagates it, crashing the process |
| Non-loadBearing failure | Logged and swallowed; dependents still proceed (their `deps` promise resolves) |
| Cycles | `topoSortPlugins` throws before any execution begins |
| `dependsOn` mutation of imported objects | Safe — module body runs before consumers see the array |
| Transition period (DB plugin exists but no `onReady` yet) | Its promise resolves immediately; all dependents start concurrently (same as today) |

### `loadBearing` failure propagation

When a `loadBearing` plugin fails, we need its dependents to NOT proceed. The `throw` inside the promise rejects it, which means any dependent's `Promise.all(deps)` also rejects, cascading the failure through the graph. The final `await Promise.all(resolved.values())` surfaces the rejection and crashes the process. This is the correct behavior.

For non-loadBearing failures, we catch and swallow — the promise resolves, dependents proceed.

## Files to modify

| File | Change |
|------|--------|
| `server/src/index.ts` | Remove inline DB init; replace parallel onReady with eager graph execution |
| `cli/src/plugin-registry-gen.ts` | Add import-graph analysis; emit `dependsOn` assignments |
| `plugins/infra/plugins/database/server/internal/plugin.ts` | Add `onReady` with `awaitPgReady()` + `runMigrations()` |

`server/src/topo.ts` — unchanged (existing `topoSortPlugins` is sufficient).

## Implementation order

1. **Eager graph execution in `index.ts`** — replace parallel onReady. Keep inline DB init. With no `dependsOn` declared yet, all promises have empty deps → same parallel behavior as today. Zero behavioral change.
2. **Update `plugin-registry-gen.ts`** — emit `dependsOn` from cross-plugin imports. Run build. Inspect generated file. First observable change: onReady now respects the graph (though all still resolve quickly since DB init is still inline).
3. **Move DB init to plugin** — add `onReady` to database plugin, remove inline calls. The graph ensures DB resolves before any dependent starts.

Steps 1 is independently deployable with zero risk. Step 2 is the structural change. Step 3 completes the migration (done by the DB agent).

## Verification

1. With no `dependsOn`, boot behavior is identical to today (all parallel)
2. With `dependsOn` populated, boot log shows each plugin starting after its deps resolve
3. End-to-end: conversation creation works (DB ready), job enqueueing works (worker started)
4. `./equin check` passes
5. Boot time: critical path adds < 200ms; plugins off the critical path see no regression
