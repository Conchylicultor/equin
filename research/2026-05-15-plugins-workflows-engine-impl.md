# Workflows Engine — Implementation Plan

## Context

The workflows app (`plugins/apps/plugins/workflows/`) has a `shell` sub-plugin providing the app layout. The engine plugin is the core backend infrastructure everything else depends on: DB tables, step executor registry, durable run job, trigger event, HTTP API, live-state resources, and the `Workflows.StepType` web slot.

Design doc: `research/2026-05-15-plugins-workflows-engine.md`

## Step 0: Prerequisite — Fix `ctx.step` SuspendSignal Handling

**File**: `plugins/infra/plugins/jobs/server/internal/step-ctx.ts`

Add `if (isSuspendSignal(err)) throw err;` as the first line of the catch block at line 193. `isSuspendSignal` is defined in the same file (line 43). Without this, a `ctx.waitFor` inside a `ctx.step` callback permanently records the SuspendSignal as an error, poisoning replay.

## Files to Create

All under `plugins/apps/plugins/workflows/plugins/engine/`:

```
engine/
  package.json
  core/
    schemas.ts          # Zod schemas (single source of truth)
    resources.ts        # resourceDescriptor declarations
    index.ts            # Public barrel
  server/
    index.ts            # ServerPluginDefinition barrel
    internal/
      tables.ts         # 3 pgTables
      tables-events.ts  # 1 trigger event
      executor-registry.ts
      resources.ts      # defineResource
      mutations.ts      # DB write helpers
      run-job.ts        # workflows.run defineJob
      routes.ts         # 10 HTTP handlers
  web/
    slots.ts            # Workflows.StepType defineSlot
    index.ts            # Web barrel
```

## Implementation Order & File Details

### 1. `package.json`

```json
{
  "name": "@singularity/plugin-apps-workflows-engine",
  "description": "Core backend infrastructure for the workflows app.",
  "private": true,
  "version": "0.0.1"
}
```

### 2. `core/schemas.ts`

Zod schemas + inferred types. No server deps — safe for web and server import.

- `DefinitionStepSchema` / `DefinitionStep` — `{ id, pluginId, label, config: z.record(z.unknown()), nextStepMapping: z.record(z.string()).nullable() }`
- `WorkflowDefinitionSchema` / `WorkflowDefinition` — `{ id, name, description: nullable, steps: DefinitionStep[], createdAt, updatedAt }` (timestamps as `z.string()`)
- `ExecutionStatusSchema` / `ExecutionStatus` — enum `["pending", "running", "suspended", "completed", "failed"]`
- `ExecutionStepStatusSchema` / `ExecutionStepStatus` — enum `["pending", "running", "suspended", "completed", "failed", "skipped"]`
- `WorkflowExecutionStepSchema` / `WorkflowExecutionStep` — all columns, timestamps as `z.string().nullable()`
- `WorkflowExecutionSchema` / `WorkflowExecution` — includes `steps: z.array(WorkflowExecutionStepSchema)`

### 3. `core/resources.ts`

```ts
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/core";
```

- `workflowDefinitionsDescriptor` — key `"workflow-definitions"`, `z.array(WorkflowDefinitionSchema)`, initial `[]`
- `workflowExecutionsDescriptor` — key `"workflow-executions"`, `z.array(WorkflowExecutionSchema)`, initial `[]`

### 4. `core/index.ts`

Re-export all schemas, types, descriptors, and `StepResult` type.

### 5. `server/internal/tables.ts`

3 pgTables. Imports: `pgTable, text, integer, timestamp, jsonb, index` from `drizzle-orm/pg-core`.

**`_workflowDefinitions`** (`"workflow_definitions"`):
- `id: text("id").primaryKey()` — prefix `wfdef-`
- `name: text("name").notNull()`
- `description: text("description")` — nullable
- `steps: jsonb("steps").$type<DefinitionStep[]>().notNull().default([])` — ordered array
- `createdAt, updatedAt: timestamp("...", { withTimezone: true }).defaultNow().notNull()`

**`_workflowExecutions`** (`"workflow_executions"`):
- `id: text("id").primaryKey()` — prefix `wfex-`
- `definitionId: text("definition_id").notNull().references(() => _workflowDefinitions.id, { onDelete: "cascade" })`
- `status: text("status").$type<ExecutionStatus>().notNull().default("pending")`
- `currentStepId: text("current_step_id")` — nullable soft FK
- `createdAt, updatedAt` + `completedAt` (nullable)

**`_workflowExecutionSteps`** (`"workflow_execution_steps"`):
- `id: text("id").primaryKey()` — prefix `wfes-`
- `executionId: text("...").notNull().references(() => _workflowExecutions.id, { onDelete: "cascade" })`
- `definitionStepId: text("...").notNull()` — logical ref, NOT an FK
- `stepIndex: integer("step_index").notNull()`
- Snapshotted: `stepPluginId, label` (text notNull), `config` (jsonb notNull default `{}`), `nextStepMapping` (jsonb nullable)
- Runtime: `status` (text, default "pending"), `input, output` (jsonb nullable), `error` (text nullable), `startedAt, completedAt` (timestamp nullable)
- Index: `(executionId, stepIndex)`

**ID generation**: inline `\`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}\`` (matches deploy/servers pattern, no nanoid).

**jsonb default syntax**: `jsonb("col").$type<T>().notNull().default([])` — confirmed working in the codebase.

### 6. `server/internal/tables-events.ts`

Pattern: `plugins/tasks-core/server/internal/tables-events.ts`

```ts
import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
```

- `userInputSubmitted` — name `"workflows.userInputSubmitted"`, filters `{ executionId: text("execution_id"), stepId: text("step_id") }`, payload includes `data: Record<string, unknown>` + index sig
- Destructure: `export const { event: userInputSubmitted, table: _userInputSubmittedTriggers } = ...`

### 7. `server/internal/executor-registry.ts`

Pure in-memory Map. No DB dependency.

```ts
import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import type { Registration } from "@server/types";
```

- `StepExecutorRunArgs` — `{ execution: { id, definitionId }, step: { id, definitionStepId, stepPluginId, label, config, nextStepMapping, input }, ctx: JobCtx }`
- `StepResult` — `{ output?, branchKey? }`
- `StepExecutorSpec` — `{ pluginId, run }`
- `defineStepExecutor(spec)` → `Registration` with `_kind: "step-executor"`, `register()` sets in Map
- `getExecutor(pluginId)` → lookup

### 8. `server/internal/resources.ts`

```ts
import { defineResource } from "@server/resources";
import { db } from "@plugins/database/server";
```

- `workflowDefinitionsResource` — key matches descriptor, mode `"push"`, loader queries `_workflowDefinitions` ordered by `createdAt desc`, serializes timestamps with `.toISOString()`
- `workflowExecutionsResource` — loader queries executions + steps (two queries, group in memory), serializes timestamps

### 9. `server/internal/mutations.ts`

DB write helpers. Each calls `resource.notify()` after writes. Does NOT import `run-job.ts` (avoids circular).

- `generateId(prefix: string)` — inline template string
- `createDefinition({ name, description, steps })` — INSERT, notify definitions
- `updateDefinition(id, patch)` — UPDATE set fields, notify definitions
- `deleteDefinition(id)` — DELETE, notify definitions
- `createExecution(definitionId)` — load definition, INSERT execution (pending), INSERT one execution_step per definition.steps[i] (snapshot all fields), notify executions. Returns execution row.
- `cancelExecution(id)` — UPDATE status="failed", completedAt, notify
- `updateExecution(id, patch)` — UPDATE, notify executions
- `updateExecutionStep(id, patch)` — UPDATE, notify executions

### 10. `server/internal/run-job.ts`

```ts
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { isSuspendSignal } from "@plugins/infra/plugins/jobs/server";
```

`workflowRunJob = defineJob({ name: "workflows.run", input: z.object({ executionId }), event: z.never(), run })`:

1. `ctx.step("init", ...)` — load execution (get definitionId), transition to "running" if pending, load definition, create execution_step rows via `db.insert(...).onConflictDoNothing()` (idempotent), load steps ordered by stepIndex. Return `{ execution, execSteps }`.

2. Walk loop with `lastOutput` piping:
   - Update step: input=lastOutput, status="running", startedAt=now()
   - Update execution: currentStepId, status="running"
   - `getExecutor(stepPluginId)` — fail if missing
   - `ctx.step(\`exec-${execStep.id}\`, () => executor.run({...}))` wrapped in try/catch:
     - `isSuspendSignal` → mark step/execution "suspended", re-throw
     - Other → mark step/execution "failed", throw
   - On success: mark step "completed", set output, advance `lastOutput`
   - Branching: if `branchKey` + `nextStepMapping`, find target, skip intervening steps

3. All done: mark execution "completed"

**jobKey**: `workflowRunJob.enqueue({ executionId }, { jobKey: executionId })`

### 11. `server/internal/routes.ts`

10 handlers in one file. Pattern: `plugins/apps/plugins/deploy/plugins/servers/server/internal/handle-*.ts`

```ts
import { db } from "@plugins/database/server";
import { eq, and, desc, asc } from "drizzle-orm";
```

| Route | Handler | Notes |
|-------|---------|-------|
| `GET /api/workflows/definitions` | list all | order by createdAt desc |
| `POST /api/workflows/definitions` | create | body: `{ name, description?, steps? }`, return 201 |
| `GET /api/workflows/definitions/:id` | get one | 404 if not found |
| `PATCH /api/workflows/definitions/:id` | update | body: partial, 404 if not found |
| `DELETE /api/workflows/definitions/:id` | delete | cascade, return 204 |
| `GET /api/workflows/executions` | list | optional `?definitionId=` filter, join steps |
| `POST /api/workflows/executions` | start | body: `{ definitionId }`, calls `createExecution` + `workflowRunJob.enqueue(...)`, return 201 |
| `GET /api/workflows/executions/:id` | get one | with steps, 404 |
| `DELETE /api/workflows/executions/:id` | cancel | calls `cancelExecution`, return 204 |
| `POST /api/.../executions/:execId/steps/:stepId/submit` | submit | validate suspended, emit `userInputSubmitted`, return 202 |

**Timestamp serialization**: all handlers call `.toISOString()` on Date fields before `Response.json()`.

### 12. `server/index.ts`

Server barrel. Named exports: tables, trigger event + table, executor registry (function + types), resources. Default export: `ServerPluginDefinition` with `httpRoutes` (all 10), `register: [workflowRunJob, userInputSubmitted]`, `contributions: [Resource.Declare(definitionsResource), Resource.Declare(executionsResource)]`.

Note: `_userInputSubmittedTriggers` (the Drizzle table) is exported but NOT in `register: []`. Only the event handle goes in register.

### 13. `web/slots.ts`

```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
```

`Workflows.StepType` — `defineSlot<{ pluginId, label, icon, configComponent?, executionComponent? }>`. Uses `defineSlot` (not `defineRenderSlot`) for programmatic access.

### 14. `web/index.ts`

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
export { Workflows } from "./slots";
export default { id: "workflows-engine", ... } satisfies PluginDefinition;
```

No contributions — only exports the slot namespace.

## Verification

1. `./equin build` — generates 4 new tables in migration: `workflow_definitions`, `workflow_executions`, `workflow_execution_steps`, `workflows_user_input_submitted_triggers`
2. `./equin check --plugin-boundaries` — passes
3. `./equin check --migrations-in-sync` — passes
4. Server boots: `workflows.run` job registered, `workflows.userInputSubmitted` event registered
5. `curl http://<worktree>.localhost:9000/api/workflows/definitions` → `[]`
6. POST a definition with `{ name: "Test", steps: [] }` → 201 with id
7. GET definitions → shows the created definition
8. POST an execution with `{ definitionId: "<id>" }` → 201, job enqueues
9. GET the execution → status "completed" (empty step chain completes immediately)

## Key Reference Files

- `plugins/infra/plugins/jobs/server/internal/step-ctx.ts` — SuspendSignal fix target (line 193)
- `plugins/tasks-core/server/internal/tables.ts` — table definition pattern
- `plugins/tasks-core/server/internal/tables-events.ts` — trigger event pattern
- `plugins/tasks-core/server/internal/resources.ts` — defineResource pattern
- `plugins/apps/plugins/deploy/plugins/servers/server/index.ts` — CRUD route + barrel pattern
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/server/internal/tables.ts` — jsonb default pattern
- `plugins/apps/plugins/workflows/plugins/shell/web/index.ts` — sibling plugin barrel
