# Workflows: DAG Engine + Branch Step

## Context

The workflows engine currently models step chains as an ordered array with a linear index walk. Branching is a forward-skip hack: `nextStepMapping` jumps the index forward and marks intermediate steps as "skipped". This works for simple cases but doesn't scale to the vision (DAG routing, conditional branches, future cycles/fan-out).

No workflow definitions exist yet, so the schema is free to change. This is the right time to evolve the execution model before the first step type plugin validates the contract.

The goal: (1) evolve the engine to a DAG model (step map + explicit edges + on-demand execution step creation), then (2) implement the `branch` step type — the first step plugin, which validates the executor registry and routing end-to-end.

## Design

### Definition schema: array → step map

```
# Before (linear chain)
steps: DefinitionStep[]              # order = execution order
nextStepMapping: branchKey → stepId  # forward-skip hack

# After (DAG)
steps: Record<string, DefinitionStep>  # keyed by step ID
entryStepId: string                    # starting node
step.next: string | null               # default successor (null = terminal)
step.nextStepMapping: Record<…> | null # branch routing (unchanged semantics)
```

Every step declares its outgoing edges explicitly. No implicit ordering from array position. Matches the AWS Step Functions model (states map + `StartAt` + `Next`).

### Execution model: pre-created → on-demand

**Before:** `createExecution` pre-creates ALL execution step rows. Unvisited branches get marked `skipped`.

**After:** `createExecution` creates only the execution row. `run-job` creates each execution step row on-demand as it's reached. Unvisited branches have no rows at all (cleaner than phantom `skipped` rows).

`stepIndex` → `executionOrder`: reflects visit order, not definition position.

### Run job: index walk → graph traversal

```
currentStepId = entryStepId
while (currentStepId) {
  stepDef = stepsMap[currentStepId]
  execStep = ctx.step("create-<stepDefId>", () => createExecutionStep(...))
  result   = ctx.step("exec-<execStepId>",  () => executor.run(...))
  currentStepId = result.branchKey → nextStepMapping[branchKey]
                  ?? stepDef.next   // null ends the loop
}
```

Simpler than the current code. No index arithmetic, no skip-marking loop.

**Replay safety:** `ctx.step("create-<definitionStepId>")` uses a stable key (definition step ID, not generated). The memoized result carries the generated execution step row (including its `id`). On replay, the DB insert is skipped entirely — `ctx.step` returns the memoized row. The subsequent `ctx.step("exec-<execStep.id>")` also replays correctly.

**Definition snapshot:** The `init` step now memoizes the full `stepsMap` + `entryStepId` (not just `execSteps` rows). This ensures in-flight executions are immune to definition edits.

### Branch step plugin

Location: `plugins/apps/plugins/workflows/plugins/steps/plugins/branch/`

Pure server-side logic — evaluates a dot-path field on `step.input`, stringifies the value, returns it as `branchKey`. The engine's existing `nextStepMapping` handles routing.

```ts
config: { field: string; defaultBranch?: string }
executor: extracts input[field] → String(value) → { branchKey }
```

Minimal web contribution: `{ pluginId: "branch", label: "Branch", icon: MdAltRoute }` to `Workflows.StepType`. No `configComponent` or `executionComponent` for v1.

## File Changes

### 1. Core schema — `engine/core/schemas.ts`

- `DefinitionStepSchema`: add `next: z.string().nullable().default(null)`
- `WorkflowDefinitionSchema`: `steps` from `z.array(DefinitionStepSchema)` → `z.record(z.string(), DefinitionStepSchema)`, add `entryStepId: z.string().nullable().default(null)`
- `WorkflowExecutionStepSchema`: rename `stepIndex` → `executionOrder`
- Keep `"skipped"` in `ExecutionStepStatusSchema` (future-proof, no harm)

### 2. DB tables — `engine/server/internal/tables.ts`

- `_workflowDefinitions`: `steps` type annotation from `DefinitionStep[]` → `Record<string, DefinitionStep>`, default `[]` → `{}`. Add `entryStepId: text("entry_step_id")`
- `_workflowExecutionSteps`: rename `stepIndex` → `executionOrder` (column `step_index` → `execution_order`), add `next: text("next")` for snapshot. Update composite index.

### 3. Mutations — `engine/server/internal/mutations.ts`

- `createDefinition`: accept `entryStepId`, pass through to insert. `steps` type changes to `Record<string, DefinitionStep>`.
- `updateDefinition`: add `entryStepId` to patchable fields.
- `createExecution`: **remove** the entire block that pre-creates execution step rows (lines ~75-89). Just insert execution row + notify.
- Add new `createExecutionStep(params)` helper for on-demand creation. Called from run-job inside `ctx.step()`.

### 4. Run job — `engine/server/internal/run-job.ts`

Full rewrite of the execution loop:
- `init` step: load definition row (with `stepsMap` + `entryStepId`), transition `pending → running`. No longer loads pre-created execution step rows.
- Graph traversal loop (see design section above).
- Remove: `InitResult` interface, `execSteps` pre-load query, forward-skip logic, `asc`/`_workflowExecutionSteps` imports.
- Add: `createExecutionStep` import from mutations.

### 5. Routes — `engine/server/internal/routes.ts`

- `handleCreateDefinition` / `handleUpdateDefinition`: accept `entryStepId` in body.
- `handleCreateExecution`: remove post-creation step fetch. Return execution with empty steps array.
- `handleListExecutions` / `handleGetExecution`: `stepIndex` → `executionOrder` in orderBy.

### 6. Resources — `engine/server/internal/resources.ts`

- `serializeDefinition`: fallback `steps: row.steps ?? {}` (was `[]`).
- Execution step serializer: `stepIndex` → `executionOrder`.
- Executions resource loader: `stepIndex` → `executionOrder` in orderBy.

### 7. Executor registry — `engine/server/internal/executor-registry.ts`

- Add `next: string | null` to `StepExecutorRunArgs.step` interface (alongside `nextStepMapping`).

### 8. New: branch step plugin

```
plugins/apps/plugins/workflows/plugins/steps/plugins/branch/
  package.json                          # @singularity/plugin-apps-workflows-steps-branch
  server/
    index.ts                            # ServerPluginDefinition, register: [branchExecutor]
    internal/
      executor.ts                       # defineStepExecutor({ pluginId: "branch", run })
  web/
    index.ts                            # PluginDefinition, Workflows.StepType.contribute(...)
```

**Server executor** (`executor.ts`):
- `getByDotPath(obj, path)` — local helper, splits on `.`, walks object
- `defineStepExecutor({ pluginId: "branch", run({ step }) { ... } })` — extract field, stringify, return `{ branchKey }`

**Web contribution** (`web/index.ts`):
- `Workflows.StepType.contribute({ pluginId: "branch", label: "Branch", icon: MdAltRoute })`
- `MdAltRoute` from `react-icons/md` — already used in the codebase for routing concepts

**Plugin registry:** auto-generated by `./equin build` — no manual edits to `web/src/plugins.ts` or `server/src/plugins.ts`.

## Implementation Order

1. Schema + tables (phases 1-2) — type errors cascade to all callsites
2. Mutations (phase 3) — depends on new table shape
3. Run-job + routes + resources (phases 4-6) — all consumers, do together
4. Executor registry (phase 7) — independent
5. Branch plugin (phase 8) — after engine builds cleanly
6. `./equin build` — generates migration, rebuilds, restarts

## Verification

1. `./equin build` succeeds (migration generated, server starts)
2. Create a definition via API with step map + entryStepId + branch step:
   ```
   POST /api/workflows/definitions
   {
     "name": "Branch test",
     "entryStepId": "s1",
     "steps": {
       "s1": { "id": "s1", "pluginId": "branch", "label": "Route",
               "config": { "field": "path" },
               "next": "s2",
               "nextStepMapping": { "skip": "s3" } },
       "s2": { "id": "s2", "pluginId": "branch", "label": "Step 2",
               "config": { "field": "x" }, "next": "s3", "nextStepMapping": null },
       "s3": { "id": "s3", "pluginId": "branch", "label": "End",
               "config": { "field": "x" }, "next": null, "nextStepMapping": null }
     }
   }
   ```
3. Create an execution and verify the run-job processes steps via graph traversal
4. Verify branch routing: step s1 with input `{ path: "skip" }` should jump to s3, skipping s2
5. Check `GET /api/workflows/executions/:id` returns only visited execution steps (not pre-created phantom rows)
6. `./equin check` passes
