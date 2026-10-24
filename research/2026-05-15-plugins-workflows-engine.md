# Workflows Engine Plugin

## Context

The workflows app needs its core backend engine — the infrastructure that everything else depends on. The `shell` sub-plugin already provides `WorkflowsApp.Sidebar` and `WorkflowsApp.Toolbar` slots. The engine adds: DB tables (3 data + 1 trigger), step executor registry, durable run job, trigger event, HTTP API, live-state resources, and the `Workflows.StepType` web slot.

**Location**: `plugins/apps/plugins/workflows/plugins/engine/`

### Prerequisite: fix `ctx.step` SuspendSignal handling

`ctx.step()` currently records ALL thrown errors permanently in `_jobSteps` — including `SuspendSignal`, which is a control-flow mechanism, not an error. This poisons the step: on replay, it rethrows a regular `Error` instead of retrying. The fix is a 1-line addition to `plugins/infra/plugins/jobs/server/internal/step-ctx.ts`:

```ts
// In the catch block of ctx.step (line ~192):
catch (err) {
  if (isSuspendSignal(err)) throw err;  // ← NEW: pass through, don't record
  const msg = err instanceof Error ? err.message : String(err);
  await db.insert(_jobSteps).values({ ... errorMessage: msg }).onConflictDoNothing();
  throw err;
}
```

With this fix, the engine can wrap each executor call in `ctx.step()`, getting replay memoization for free. The `execution_steps` table becomes pure domain state (UI display, monitoring) rather than a parallel replay mechanism. One replay system (`_jobSteps`) instead of two.

---

## File Structure

```
engine/
  package.json
  server/
    index.ts                      # ServerPluginDefinition barrel
    internal/
      tables.ts                   # 3 pgTables
      tables-events.ts            # 1 trigger event
      resources.ts                # 2 defineResource declarations
      executor-registry.ts        # defineStepExecutor + registry Map
      run-job.ts                  # workflows.run defineJob
      mutations.ts                # DB mutation helpers
      routes.ts                   # HTTP route handlers
  web/
    index.ts                      # PluginDefinition barrel (exports Workflows namespace)
    slots.ts                      # Workflows.StepType defineSlot
  core/
    index.ts                      # Public types/schemas/descriptors for cross-plugin use
    schemas.ts                    # Zod schemas (single source of truth)
    resources.ts                  # resourceDescriptor declarations
```

---

## 1. DB Tables — `server/internal/tables.ts`

Imports: `pgTable, text, integer, timestamp, jsonb, index` from `drizzle-orm/pg-core`.

### Design decisions

- **Definition steps are inline JSONB**, not a separate table. Definitions are always read/written as a unit, steps are small (3–10 per workflow), and ordering is implicit in array position. This matches the standard pattern (n8n, AWS Step Functions, Retool).
- **Execution steps are separate rows** because each has mutable runtime state (status, timing), gets updated independently during the run, and triggers individual live-state notifications.
- **Execution steps snapshot definition fields** (`stepPluginId`, `label`, `config`, `nextStepMapping`) at creation time. Editing a definition never affects running executions. No FK back to definition steps.

### `_workflowDefinitions` ("workflow_definitions")

| Column | Type | Notes |
|--------|------|-------|
| id | `text("id").primaryKey()` | `wfdef-<nanoid>` |
| name | `text("name").notNull()` | |
| description | `text("description")` | nullable |
| steps | `jsonb("steps").notNull().$type<DefinitionStep[]>().default([])` | ordered array of step configs (see shape below) |
| createdAt | `timestamp("created_at", { withTimezone: true }).defaultNow().notNull()` | |
| updatedAt | `timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()` | |

**DefinitionStep shape** (inline in `steps` JSONB):

```ts
interface DefinitionStep {
  id: string;           // nanoid, stable across edits (generated client-side when adding a step)
  pluginId: string;     // matches executor registry key
  label: string;
  config: Record<string, unknown>;  // step-type-specific config blob
  nextStepMapping: Record<string, string> | null;  // null = linear; { branchKey: targetStepId }
}
```

### `_workflowExecutions` ("workflow_executions")

| Column | Type | Notes |
|--------|------|-------|
| id | `text("id").primaryKey()` | `wfex-<nanoid>` |
| definitionId | `text("definition_id").notNull().references(() => _workflowDefinitions.id, { onDelete: "cascade" })` | |
| status | `text("status").$type<ExecutionStatus>().notNull().default("pending")` | pending/running/suspended/completed/failed |
| currentStepId | `text("current_step_id")` | soft FK to execution_steps |
| createdAt | `timestamp("created_at", { withTimezone: true }).defaultNow().notNull()` | |
| updatedAt | `timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()` | |
| completedAt | `timestamp("completed_at", { withTimezone: true })` | |

### `_workflowExecutionSteps` ("workflow_execution_steps")

| Column | Type | Notes |
|--------|------|-------|
| id | `text("id").primaryKey()` | `wfes-<nanoid>` |
| executionId | `text("execution_id").notNull().references(() => _workflowExecutions.id, { onDelete: "cascade" })` | |
| definitionStepId | `text("definition_step_id").notNull()` | references DefinitionStep.id (logical, not an FK) |
| stepIndex | `integer("step_index").notNull()` | position in the definition's steps array |
| stepPluginId | `text("step_plugin_id").notNull()` | snapshotted from definition step |
| label | `text("label").notNull()` | snapshotted |
| config | `jsonb("config").notNull().default({})` | snapshotted |
| nextStepMapping | `jsonb("next_step_mapping")` | snapshotted; null = linear |
| status | `text("status").$type<ExecutionStepStatus>().notNull().default("pending")` | pending/running/suspended/completed/failed/skipped |
| input | `jsonb("input")` | previous step's output, piped by the engine |
| output | `jsonb("output")` | step result stored on completion |
| error | `text("error")` | error message on failure |
| startedAt | `timestamp("started_at", { withTimezone: true })` | |
| completedAt | `timestamp("completed_at", { withTimezone: true })` | |

Index: `(executionId, stepIndex)`

---

## 2. Trigger Event — `server/internal/tables-events.ts`

Pattern from `plugins/tasks-core/server/internal/tables-events.ts`. Import `defineTriggerEvent` from `@plugins/infra/plugins/events/server`, `text` from `drizzle-orm/pg-core`.

### `userInputSubmitted`

Emitted when user POSTs to the step submit endpoint.

```ts
interface UserInputSubmittedPayload {
  executionId: string;
  stepId: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}
// filters: { executionId: text("execution_id"), stepId: text("step_id") }
```

Exported as `{ event, table }`. Table re-exported as `_userInputSubmittedTriggers`.

---

## 3. Zod Schemas — `core/schemas.ts`

Single source of truth for shapes. Both web and server import from here.

```ts
export const DefinitionStepSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  label: z.string(),
  config: z.record(z.unknown()).default({}),
  nextStepMapping: z.record(z.string()).nullable().default(null),
});
export type DefinitionStep = z.infer<typeof DefinitionStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().nullable(),
  steps: z.array(DefinitionStepSchema),
  createdAt: z.string(), updatedAt: z.string(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const ExecutionStatusSchema = z.enum(["pending", "running", "suspended", "completed", "failed"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionStepStatusSchema = z.enum(["pending", "running", "suspended", "completed", "failed", "skipped"]);
export type ExecutionStepStatus = z.infer<typeof ExecutionStepStatusSchema>;

export const WorkflowExecutionStepSchema = z.object({
  id: z.string(), executionId: z.string(), definitionStepId: z.string(),
  stepIndex: z.number(), stepPluginId: z.string(), label: z.string(),
  config: z.record(z.unknown()), nextStepMapping: z.record(z.string()).nullable(),
  status: ExecutionStepStatusSchema, input: z.unknown().nullable(),
  output: z.unknown().nullable(), error: z.string().nullable(),
  startedAt: z.string().nullable(), completedAt: z.string().nullable(),
});
export type WorkflowExecutionStep = z.infer<typeof WorkflowExecutionStepSchema>;

export const WorkflowExecutionSchema = z.object({
  id: z.string(), definitionId: z.string(), status: ExecutionStatusSchema,
  currentStepId: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().nullable(),
  steps: z.array(WorkflowExecutionStepSchema),
});
export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;
```

---

## 4. Step Executor Registry — `server/internal/executor-registry.ts`

```ts
import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import type { Registration } from "@server/types";

export interface StepExecutorRunArgs {
  execution: { id: string; definitionId: string };
  step: {
    id: string;
    definitionStepId: string;
    stepPluginId: string;
    label: string;
    config: unknown;
    nextStepMapping: Record<string, string> | null;
    input: unknown;
  };
  ctx: JobCtx;
}

export interface StepResult {
  output?: unknown;
  branchKey?: string;
}

export interface StepExecutorSpec {
  pluginId: string;
  run: (args: StepExecutorRunArgs) => Promise<StepResult>;
}

const executorRegistry = new Map<string, StepExecutorSpec>();

export function defineStepExecutor(spec: StepExecutorSpec): Registration {
  return {
    _kind: "step-executor",
    _factory: "defineStepExecutor",
    _doc: { label: spec.pluginId },
    register() {
      executorRegistry.set(spec.pluginId, spec);
    },
  };
}

export function getExecutor(pluginId: string): StepExecutorSpec | undefined {
  return executorRegistry.get(pluginId);
}
```

Step type plugins import `defineStepExecutor` from `@plugins/apps/plugins/workflows/plugins/engine/server` and add the returned Registration to their `register: []`.

Note: `step` arg contains all snapshotted definition fields — no separate `definitionStep` arg needed. The executor accesses config via `step.config` and input from previous steps via `step.input`.

---

## 5. Durable Run Job — `server/internal/run-job.ts`

```ts
export const workflowRunJob = defineJob({
  name: "workflows.run",
  input: z.object({ executionId: z.string() }),
  event: z.never(),
  run: async ({ input, ctx }) => { /* replay-safe loop */ },
});
```

### Replay-Safe Loop Algorithm

The engine wraps each executor call in `ctx.step()` — replay memoization is handled by `_jobSteps`. The `execution_steps` table is updated for UI/monitoring purposes but is NOT consulted for replay decisions.

```
1. ctx.step("init", () => {
     Load execution by input.executionId
     If status in ("completed", "failed") → return early marker
     If status == "pending" → UPDATE status = "running", notify resources
     Load definition (to read steps array)
     Create execution_step rows for each definition step (if not already created):
       snapshot stepPluginId, label, config, nextStepMapping from definition.steps[i]
       set stepIndex = i, status = "pending"
     Load execution_steps ordered by stepIndex ASC
     Return { execSteps }
   })

2. Walk step chain:
   let lastOutput: unknown = null;
   let currentIndex = 0;

   WHILE currentIndex < execSteps.length:
     execStep = execSteps[currentIndex]

     // Pipe previous output as input + mark running
     UPDATE execStep input = lastOutput, status = "running", startedAt = now()
     UPDATE execution currentStepId = execStep.id, status = "running"
     notify resources

     executor = getExecutor(execStep.stepPluginId)
     if !executor → mark step/execution "failed", return

     // ctx.step handles replay: completed steps return cached result,
     // suspended steps re-run fn (SuspendSignal passes through, not recorded)
     result = await ctx.step(`exec-${execStep.id}`, async () => {
       return executor.run({
         execution,
         step: { ...execStep, input: lastOutput },
         ctx,
       })
     })

     // Step completed — update domain state
     UPDATE execStep status = "completed", output = result.output, completedAt = now()
     lastOutput = result.output
     notify resources

     // Handle branching
     if result.branchKey AND execStep.nextStepMapping:
       targetDefStepId = execStep.nextStepMapping[result.branchKey]
       targetIndex = execSteps.findIndex(s => s.definitionStepId === targetDefStepId)
       mark intervening pending steps as "skipped"
       currentIndex = targetIndex
     else:
       currentIndex++

3. All steps done:
   UPDATE execution status = "completed", completedAt = now()
   notify resources
```

**Error handling around the ctx.step call**: The engine wraps the `ctx.step` call itself in a try/catch:
- `isSuspendSignal(err)` → update execStep status to "suspended", execution to "suspended", notify resources, re-throw
- Other errors → update execStep status to "failed" with error message, execution to "failed", notify resources, throw

**How replay works with ctx.step**:
1. Job reruns from the top after resume
2. `ctx.step("init", ...)` returns the cached init result (no DB hit)
3. The loop walks step by step. For completed steps, `ctx.step("exec-<id>", ...)` returns the cached result — the executor is never re-called
4. For the suspended step, `ctx.step("exec-<id>", ...)` re-runs fn (SuspendSignal was never recorded thanks to the prerequisite fix). The executor's internal `ctx.waitFor` finds the resolved `_jobWaits` row and returns the payload
5. Subsequent steps run fresh

**Domain state updates are idempotent**: Writing "running" to a step that's already "running" is a no-op. On replay, the engine writes the same domain state transitions it did on the first run — harmless.

**jobKey**: Enqueue with `jobKey: executionId` so `workflowRunId` is stable across suspends/resumes — essential for `ctx.step`/`ctx.waitFor` memoization.

---

## 6. Resources — `server/internal/resources.ts` + `core/resources.ts`

### Server resources

```ts
export const workflowDefinitionsResource = defineResource({
  key: "workflow-definitions",
  mode: "push",
  schema: z.array(WorkflowDefinitionSchema),
  loader: async () => { /* query definitions ordered by createdAt desc */ },
});

export const workflowExecutionsResource = defineResource({
  key: "workflow-executions",
  mode: "push",
  schema: z.array(WorkflowExecutionSchema),
  loader: async () => { /* query executions + join steps, ordered by createdAt desc */ },
});
```

### Core resource descriptors

```ts
export const workflowDefinitionsDescriptor = resourceDescriptor(
  "workflow-definitions", z.array(WorkflowDefinitionSchema), [],
);
export const workflowExecutionsDescriptor = resourceDescriptor(
  "workflow-executions", z.array(WorkflowExecutionSchema), [],
);
```

Keys must match between server `defineResource` and core `resourceDescriptor`.

---

## 7. HTTP Routes — `server/internal/routes.ts`

Handler signature: `(req: Request, params: Record<string, string>) => Response | Promise<Response>`

| Method | Path | Notes |
|--------|------|-------|
| `GET /api/workflows/definitions` | List all definitions | |
| `POST /api/workflows/definitions` | Create definition | body: `{ name, description?, steps: DefinitionStep[] }` |
| `GET /api/workflows/definitions/:id` | Get single definition | |
| `PATCH /api/workflows/definitions/:id` | Update definition | body: `{ name?, description?, steps? }` |
| `DELETE /api/workflows/definitions/:id` | Delete definition (cascades) | |
| `GET /api/workflows/executions` | List executions | optional `?definitionId=` filter |
| `POST /api/workflows/executions` | Start execution → enqueue job | body: `{ definitionId }` |
| `GET /api/workflows/executions/:id` | Get execution with steps | |
| `DELETE /api/workflows/executions/:id` | Cancel execution | marks failed |
| `POST /api/workflows/executions/:execId/steps/:stepId/submit` | User submits for suspended step | body: `{ data }` → emits `userInputSubmitted` |

### Submit endpoint detail

1. Parse `{ data: Record<string, unknown> }` from body
2. Validate execution exists and step.status === "suspended"
3. Call `userInputSubmitted.emit({ executionId, stepId, data })`
4. Return `202 Accepted` — the event system handles job resumption via `_jobWaits` resolution

---

## 8. Mutations — `server/internal/mutations.ts`

Helpers called by routes and run-job. Each mutation calls `resource.notify()` after writes.

- `createDefinition(name, description, steps[])` — single INSERT with steps as JSONB
- `updateDefinition(id, patch)` — single UPDATE (name, description, and/or steps JSONB)
- `deleteDefinition(id)` — single DELETE (cascade handles executions)
- `startExecution(definitionId)` — load definition, insert execution (pending), insert one execution_step per definition step (snapshotting pluginId, label, config, nextStepMapping, stepIndex), enqueue `workflowRunJob.enqueue({ executionId }, { jobKey: executionId })`
- `cancelExecution(id)` — mark execution "failed", update timestamp
- `updateExecutionStep(id, patch)` — used by run-job to update step status/input/output/error
- `updateExecution(id, patch)` — used by run-job to update execution status/currentStepId

---

## 9. Web Slot — `web/slots.ts`

`defineSlot` (not `defineRenderSlot`) because consumers need programmatic access to metadata, not just rendering.

```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";

export const Workflows = {
  StepType: defineSlot<{
    pluginId: string;
    label: string;
    icon: ComponentType<{ className?: string }>;
    configComponent?: ComponentType<{ config: unknown; onChange: (config: unknown) => void }>;
    executionComponent?: ComponentType<{
      step: WorkflowExecutionStep;
      execution: WorkflowExecution;
    }>;
  }>("workflows.step-type", { docLabel: (p) => p.label }),
};
```

Step type plugins contribute via `Workflows.StepType({ pluginId: "prompt-form", ... })` in their web `contributions: []`. The definition-editor uses `.useContributions()` to enumerate types; the execution pane matches by `stepPluginId` to render the active step.

Note: `executionComponent` receives the execution_step directly — it carries snapshotted config, so no definition lookup is needed.

---

## 10. Server Barrel — `server/index.ts`

```ts
// Named exports (public API):
export { _workflowDefinitions, _workflowExecutions, _workflowExecutionSteps } from "./internal/tables";
export { userInputSubmitted, _userInputSubmittedTriggers } from "./internal/tables-events";
export { defineStepExecutor, getExecutor } from "./internal/executor-registry";
export type { StepExecutorSpec, StepResult, StepExecutorRunArgs } from "./internal/executor-registry";
export { workflowDefinitionsResource, workflowExecutionsResource } from "./internal/resources";

export default {
  id: "workflows-engine",
  name: "Workflows: Engine",
  description: "Core backend infrastructure for the workflows app. Owns DB tables, step executor registry, durable run job, trigger event, HTTP API, and live-state resources.",
  httpRoutes: { /* all 10 routes */ },
  register: [workflowRunJob, userInputSubmitted],
  contributions: [
    Resource.Declare(workflowDefinitionsResource),
    Resource.Declare(workflowExecutionsResource),
  ],
} satisfies ServerPluginDefinition;
```

---

## 11. Web Barrel — `web/index.ts`

```ts
export { Workflows } from "./slots";

export default {
  id: "workflows-engine",
  name: "Workflows: Engine",
  description: "Core engine infrastructure. Defines the Workflows.StepType slot.",
} satisfies PluginDefinition;
```

No web contributions — only exports the slot namespace.

---

## 12. Core Barrel — `core/index.ts`

```ts
export {
  DefinitionStepSchema, WorkflowDefinitionSchema,
  ExecutionStatusSchema, ExecutionStepStatusSchema,
  WorkflowExecutionStepSchema, WorkflowExecutionSchema,
} from "./schemas";
export type {
  DefinitionStep, WorkflowDefinition,
  ExecutionStatus, ExecutionStepStatus,
  WorkflowExecutionStep, WorkflowExecution,
} from "./schemas";
export { workflowDefinitionsDescriptor, workflowExecutionsDescriptor } from "./resources";
```

Also exports `StepResult` type (no server deps).

---

## 13. How Step Type Plugins Integrate

### Server side (e.g. `steps/prompt-form/server/index.ts`)

```ts
import { defineStepExecutor, userInputSubmitted } from "@plugins/apps/plugins/workflows/plugins/engine/server";

const promptFormExecutor = defineStepExecutor({
  pluginId: "prompt-form",
  async run({ execution, step, ctx }) {
    const payload = await ctx.waitFor(
      userInputSubmitted.where({ executionId: execution.id, stepId: step.id }),
    );
    return { output: payload?.data ?? {} };
  },
});

export default { id: "workflows-step-prompt-form", register: [promptFormExecutor] } satisfies ServerPluginDefinition;
```

### Web side (e.g. `steps/prompt-form/web/index.ts`)

```ts
import { Workflows } from "@plugins/apps/plugins/workflows/plugins/engine/web";

export default {
  id: "workflows-step-prompt-form",
  contributions: [
    Workflows.StepType({ pluginId: "prompt-form", label: "Prompt Form", icon: MdEditNote, configComponent: ..., executionComponent: ... }),
  ],
} satisfies PluginDefinition;
```

---

## 14. Resume Flow (Prompt-Form Example)

1. `workflows.run` job starts → inits execution steps (snapshotting from definition) → walks to first pending step
2. Engine pipes `lastOutput` (null for first step) as input → calls `ctx.step("exec-<id>", () => executor.run(...))`
3. Executor calls `ctx.waitFor(userInputSubmitted.where(...))`
4. First run: `ctx.waitFor` inserts `_jobWaits` row (pending), registers oneShot trigger, throws `SuspendSignal`
5. `SuspendSignal` passes through `ctx.step` (not recorded, thanks to the fix)
6. Engine catches it → marks execution_step "suspended", execution "suspended", re-throws
7. Job framework suspends (graphile job completes cleanly)
8. User POSTs `/api/workflows/executions/:id/steps/:stepId/submit` with `{ data }`
9. Handler calls `userInputSubmitted.emit({ executionId, stepId, data })`
10. Events dispatch resolves `_jobWaits` row → re-enqueues `workflows.run` with same jobKey
11. Job reruns → `ctx.step("init")` returns cached init → loop walks steps
12. `ctx.step("exec-<id>")` re-runs fn (SuspendSignal was never recorded) → executor's `ctx.waitFor` finds resolved `_jobWaits` → returns payload
13. Executor returns `{ output: payload.data }` → `ctx.step` caches the result → engine marks step completed, sets `lastOutput` → continues to next step with piped input

---

## 15. Implementation Order

0. **Prerequisite**: Fix `ctx.step` SuspendSignal pass-through in `plugins/infra/plugins/jobs/server/internal/step-ctx.ts`
1. `package.json`
2. `core/schemas.ts` + `core/resources.ts` + `core/index.ts` (types first)
3. `server/internal/tables.ts` (DB schema — 3 tables)
4. `server/internal/tables-events.ts` (trigger event)
5. `server/internal/executor-registry.ts`
6. `server/internal/resources.ts` (defineResource)
7. `server/internal/mutations.ts`
8. `server/internal/run-job.ts`
9. `server/internal/routes.ts`
10. `server/index.ts` (barrel + plugin definition)
11. `web/slots.ts` + `web/index.ts`

---

## 16. Verification

1. `./equin build` — generates 4 tables (3 data + 1 trigger), builds server + web
2. `./equin check --plugin-boundaries` — no illegal imports
3. `./equin check --migrations-in-sync` — migration matches schema
4. Server boots without errors, job and event register
5. `curl http://<worktree>.localhost:9000/api/workflows/definitions` → `[]`
6. Create a definition via POST, verify it shows in GET
7. Start an execution via POST, verify execution with snapshotted pending steps appears

---

## Critical Files to Reference During Implementation

- `plugins/tasks-core/server/internal/tables.ts` — FK + index patterns
- `plugins/tasks-core/server/internal/tables-events.ts` — defineTriggerEvent pattern
- `plugins/tasks-core/server/internal/resources.ts` — defineResource + loader pattern
- `plugins/tasks-core/server/index.ts` — barrel pattern with register + contributions
- `plugins/infra/plugins/jobs/server/internal/registry.ts` — Registration interface shape
- `plugins/infra/plugins/jobs/server/internal/step-ctx.ts` — SuspendSignal, isSuspendSignal
- `plugins/apps/plugins/deploy/plugins/servers/server/index.ts` — CRUD route pattern
