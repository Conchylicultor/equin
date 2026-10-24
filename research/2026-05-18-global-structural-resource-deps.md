# Structural Resource Dependencies

## Context

The queue's pin state goes stale when a conversation transitions from `waiting` → `working`. The queue resource's loader calls `validatePin()`, which joins against the `conversations` table, but declares no `dependsOn` — so when `conversationsLiveResource` notifies, the queue resource never cascades. Refreshing fixes it because the loader re-runs unconditionally on subscription.

The root cause is structural: `dependsOn` is an optional, separate declaration from the loader. A resource can silently depend on upstream data without the framework knowing. Nothing forces the author to declare it, and omitting it compiles and works on first load.

## Approach

Two-layer defense:

1. **Make `deps` required on `ResourceDefinition`** — TypeScript refuses to compile a resource without declaring its dependencies. Even `deps: []` is an explicit assertion of independence.

2. **Add a static check** (`live-state:resource-deps`) — catches `deps: []` when the plugin's server code imports from another plugin that exports resources.

The queue resource gets `deps: [conversationsLiveResource]` as the immediate fix.

## Part 1: API change in `server/src/resources.ts`

Rename `dependsOn` → `deps`. Make it required. Add shorthand for the common no-`map` case:

```ts
// Before
interface ResourceDefinition<T, P> {
  dependsOn?: ReadonlyArray<DependsOnEntry<P>>;
  // ...
}

// After
interface ResourceDefinition<T, P> {
  deps: ReadonlyArray<DependsOnEntry<P> | Resource<any, any>>;
  // ...
}
```

Bare `Resource` references are shorthand for `{ resource: R }`. Type guard to distinguish:

```ts
function isResource(dep: DependsOnEntry<any> | Resource<any, any>): dep is Resource<any, any> {
  return 'load' in dep && 'notify' in dep;
}
```

In the `defineResource` body (line 117), update the iteration:

```ts
for (const dep of def.deps) {
  const entry = isResource(dep)
    ? { resource: dep, map: undefined }
    : dep;
  upstreamKeys.push(entry.resource.key);
  // ... rest unchanged
}
```

### Files to modify
- `server/src/resources.ts` — `ResourceDefinition`, `defineResource`, type guard

## Part 2: Migrate all existing resources

~39 resources need `deps: []` added. 8 existing `dependsOn` users rename to `deps` with shorthand where possible.

### Resources already using `dependsOn` → rename to `deps` with shorthand

| Resource | File | New `deps` |
|---|---|---|
| `attemptsResource` | `plugins/tasks-core/server/internal/resources.ts` | `deps: [conversationsLiveResource, pushesResource]` |
| `tasksResource` | same file | `deps: [attemptsResource]` |
| `agentLaunchesResource` | `plugins/agents/server/internal/resources.ts` | `deps: [conversationsLiveResource]` |
| `mainAheadCountResource` | `plugins/build/server/internal/main-ahead-resource.ts` | `deps: [{ resource: refHeadResource, map: ... }]` (keeps wrapper — has map) |
| `commitDeltaResource` | `plugins/.../commits-graph/server/internal/resources.ts` | `deps: [{ resource: pushesResource, map: ... }]` (keeps wrapper) |
| `commitsGraphResource` | same file | `deps: [{ resource: pushesResource, map: ... }]` (keeps wrapper) |

### Resources needing `deps: []`

Every other `defineResource` call (~39 files). Each change is one line: add `deps: [],`.

Full list in the Plan agent's inventory above. Mechanical, zero-risk.

## Part 3: Fix the queue resource

**File:** `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/resource.ts`

```ts
import { conversationsLiveResource } from "@plugins/tasks-core/server";

export const queueRanksResource = defineResource({
  key: "queue-ranks",
  mode: "push",
  schema: QueueDataSchema,
  deps: [conversationsLiveResource],  // ← cascades on any conversation status change
  loader: async (): Promise<QueueData> => {
    // ... unchanged
  },
});
```

Both are parameterless, so the cascade is identity — no `map` needed. When any conversation status changes → `conversationsLiveResource.notify()` → cascades to `queueRanksResource` → loader re-runs → `validatePin()` sees the new status → pushes correct pin to frontend.

## Part 4: Static check — `live-state:resource-deps`

**New file:** `plugins/primitives/plugins/live-state/check/index.ts`

This is the first plugin-contributed check, using the existing `loadPluginChecks` discovery mechanism in `tooling/src/checks/index.ts:63`.

### Algorithm

1. Build the plugin tree via `buildPluginTree()`
2. Scan all `.ts` files in the repo for `defineResource` calls. For each, record:
   - The owning plugin (derived from file path)
   - The `deps` entries (parsed from the AST or regex — extract resource keys referenced)
3. Build a map: `pluginHierarchyId → Set<resourceKey>` (which plugins export resources)
4. For each plugin that defines a resource:
   - Collect all `@plugins/*/server` imports across its `server/` directory tree
   - For each imported plugin: does it export any resources?
   - If yes: does the defining resource's `deps` reference at least one resource from that plugin?
   - If no: **warn**

### Exemption mechanism

Some cross-plugin server imports are for mutations (e.g., `createConversation`), not reads. The check allows exemption via a `// resource-deps-exempt` comment on the import line.

### Why plugin-contributed, not built-in

The check is domain-specific to the live-state resource system, owned by the `live-state` plugin. Placing it in `check/index.ts` follows plugin ownership principles. The discovery mechanism already exists but has zero users — this sets the pattern.

## Part 5: Update documentation

- `server/CLAUDE.md` — update the `defineResource` example to show `deps: []` (and the shorthand)
- `plugins/primitives/plugins/live-state/CLAUDE.md` — document the `deps` field and the check

## Verification

1. `./equin build` — compiles successfully, server starts, gateway routes work
2. Open `http://<worktree>.localhost:9000`, navigate to the queue view
3. Send a message to the pinned conversation (or resume it) → verify the pin moves immediately to the next waiting conversation without a page refresh
4. `./equin check --live-state:resource-deps` — passes (all deps are correctly declared)
5. Temporarily remove `deps: [conversationsLiveResource]` from the queue resource → check should warn about the missing dependency

## Scope

- ~40 files touched for `deps: []` migration (one line each)
- 1 file modified for the queue fix
- 1 file modified for the API change (`server/src/resources.ts`)
- 1 new file for the check
- 2 docs updated
