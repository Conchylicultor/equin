# Static Trigger Unification: arm-auto-start

## Context

`armTaskAutoStart` creates 2N dynamic `oneShot` trigger rows per armed task (one for `status=done`, one for `status=dropped`, per dependency). These rows are a denormalized copy of the `task_dependencies` table. `maybeLaunchTaskJob` already re-checks `hasBlockingDep()` at execution time, making the per-dep routing redundant. The dynamic rows also accumulate orphans (no cascade when a task is deleted), block declarative trigger sync (can't "delete everything not declared" without destroying runtime-created rows), and grow linearly with the dependency graph.

A single static trigger on `taskStatusChanged` replaces all of them: the job queries `task_dependencies` + `tasks_ext_auto_start` to find armed dependents, then fans out to `maybeLaunchTaskJob`. The dependency graph stays in one place, trigger rows don't accumulate, and all triggers become startup-declared.

## Changes

### 1. New query: `listArmedDependentsOf` in tasks-core

**File:** `plugins/tasks-core/server/internal/queries/tasks.ts`

Add a reverse-lookup query: "given a task that just changed status, find all armed tasks that depend on it."

```ts
export async function listArmedDependentsOf(changedTaskId: string): Promise<string[]> {
  const result = await db.execute<{ task_id: string }>(
    sql`SELECT DISTINCT td.task_id
        FROM task_dependencies td
        JOIN tasks_ext_auto_start tas ON tas.parent_id = td.task_id
        WHERE td.depends_on_task_id = ${changedTaskId}`,
  );
  return result.rows.map((r) => r.task_id);
}
```

Uses raw SQL to avoid importing the auto-start sub-plugin's table into tasks-core (same pattern as `hasBlockingDep`'s raw SQL against `attempts`). The `task_deps_depends_on_idx` index on `depends_on_task_id` makes this cheap.

**Also:** export from `plugins/tasks-core/server/index.ts`.

### 2. New job: `maybeLaunchDependentsJob` in conversations

**File:** `plugins/conversations/server/internal/auto-start-jobs.ts`

Add alongside `maybeLaunchTaskJob`:

```ts
export const maybeLaunchDependentsJob = defineJob({
  name: "tasks.maybe-launch-dependents",
  input: z.object({}),
  event: z.object({
    taskId: z.string(),
    parentId: z.string().nullable(),
    status: z.string(),
    previousStatus: z.string(),
  }).passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (event.status !== "done" && event.status !== "dropped") return;
    const dependents = await listArmedDependentsOf(event.taskId);
    await Promise.all(
      dependents.map((taskId) => maybeLaunchTaskJob.enqueue({ taskId })),
    );
  },
});
```

Key design points:
- `input: z.object({})` — the static trigger carries no per-instance config.
- `event` typed to `TaskStatusChangedPayload` shape with `.passthrough()` for forward compat. The dispatch job validates this against the schema before calling `run`.
- Early-returns on non-done/dropped status changes (the common case — held, active, etc.) before touching the DB.
- No `isMain()` guard here — `maybeLaunchTaskJob` already has one.
- `Promise.all` fan-out is safe: each `maybeLaunchTaskJob` invocation has its own CAS via `claimAutoStart()`.

### 3. Register the static trigger in conversations plugin

**File:** `plugins/conversations/server/index.ts`

```ts
import { maybeLaunchDependentsJob } from "./internal/auto-start-jobs";  // add
import { taskStatusChanged } from "@plugins/tasks-core/server";          // add
import { deleteTriggersFor, trigger } from "@plugins/infra/plugins/events/server"; // add

// In register array:
register: [maybeLaunchTaskJob, maybeLaunchDependentsJob, ...],

// In onReady:
onReady: async () => {
  await ensureSystemMeta();
  startPoller();
  startTurnEmitter();

  // Sweep stale per-dep oneShot rows from old armTaskAutoStart calls.
  await deleteTriggersFor(maybeLaunchTaskJob);
  // Single static trigger replaces all dynamic per-dep triggers.
  await deleteTriggersFor(maybeLaunchDependentsJob);
  await trigger({
    on: taskStatusChanged,  // no .where() — match all transitions
    do: maybeLaunchDependentsJob,
    with: {},
    oneShot: false,
  });
},
```

The `deleteTriggersFor(maybeLaunchTaskJob)` call is a one-time cleanup: it sweeps all old `oneShot` rows targeting `tasks.maybe-launch` that the previous dynamic code created. After this deploy, no new rows will be created for that job via triggers. This line can be removed in a future cleanup once all servers have restarted at least once.

### 4. Simplify `armTaskAutoStart`

**File:** `plugins/tasks/server/internal/arm-auto-start.ts`

```ts
import { hasBlockingDep } from "@plugins/tasks-core/server";
import { setTaskAutoStart } from "@plugins/tasks/plugins/auto-start/server";
import { maybeLaunchTaskJob } from "@plugins/conversations/server";

export async function armTaskAutoStart(args: {
  taskId: string;
  model: "opus" | "sonnet";
  dependencies: readonly string[];
}): Promise<void> {
  const { taskId, model } = args;
  await setTaskAutoStart(taskId, { model });
  if (!(await hasBlockingDep(taskId))) {
    await maybeLaunchTaskJob.enqueue({ taskId });
  }
  // If blocked: the static taskStatusChanged → maybeLaunchDependentsJob
  // trigger will fire when deps complete, querying task_dependencies to
  // find this task.
}
```

Remove the `trigger` import from `@plugins/infra/plugins/events/server` and the `taskStatusChanged` import from `@plugins/tasks-core/server` — neither is needed anymore. The `dependencies` parameter stays in the signature for call-site compatibility (4 callers pass it); the implementation ignores it.

### 5. Update `maybeLaunchTaskJob` comment

**File:** `plugins/conversations/server/internal/auto-start-jobs.ts`

Update the doc comment on `maybeLaunchTaskJob` to reflect the new routing: "Invoked by `maybeLaunchDependentsJob` (static trigger) or directly by `armTaskAutoStart` (no blocking deps at queue time)." Remove the reference to per-dep triggers in `handle-create.ts`.

## File summary

| File | Action |
|------|--------|
| `plugins/tasks-core/server/internal/queries/tasks.ts` | Add `listArmedDependentsOf` |
| `plugins/tasks-core/server/index.ts` | Export `listArmedDependentsOf` |
| `plugins/conversations/server/internal/auto-start-jobs.ts` | Add `maybeLaunchDependentsJob`, update `maybeLaunchTaskJob` comment |
| `plugins/conversations/server/index.ts` | Import/export/register `maybeLaunchDependentsJob`, add `onReady` trigger setup + stale cleanup |
| `plugins/tasks/server/internal/arm-auto-start.ts` | Remove trigger loop and trigger/event imports; simplify to set + check + enqueue |

## Deployment safety

Old `oneShot` trigger rows created by the previous code are harmless during rollout:
- They fire `maybeLaunchTaskJob` which re-checks all guards (`getTaskAutoStart`, `hasBlockingDep`, `claimAutoStart`).
- The new static trigger may also fire for the same event, producing a double-enqueue — CAS in `claimAutoStart()` ensures exactly-one launch.
- Old rows self-delete after firing (`oneShot: true`).
- On next server restart, `deleteTriggersFor(maybeLaunchTaskJob)` sweeps any remaining rows.

No migration needed.

## Verification

1. `./equin build` — confirms no type errors, generates any needed migrations (none expected).
2. `./equin check` — passes all checks including plugin-boundaries and eslint.
3. Manual test flow:
   - Create task A, create task B with dependency on A and `autoStart: true`.
   - Verify no trigger rows in `tasks_statusChanged_triggers` for `maybeLaunchTaskJob` (query via `query_db`).
   - Verify one standing trigger row for `maybeLaunchDependentsJob` with `task_id IS NULL AND status IS NULL` (matches all).
   - Complete task A → verify task B auto-launches.
4. Edge cases:
   - Task with multiple deps: complete all but one → verify B doesn't launch. Complete last → B launches.
   - Task deleted before deps complete → `maybeLaunchTaskJob` bails at existence check.
   - Manual launch races auto-start → CAS + attempts check prevents double launch.

## Not in scope

**Declarative trigger sync** — the infrastructure-level feature where startup declarations are the source of truth and stale rows get auto-cleaned. This PR eliminates the only production dynamic trigger caller, making that future work purely additive. The existing `deleteTriggersFor` + `trigger` pattern in each plugin's `onReady` continues to work.
