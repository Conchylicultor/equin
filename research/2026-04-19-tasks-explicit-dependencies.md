# Tasks: explicit dependencies

## Context

Tasks currently model hierarchy via a single `parentId` column and express
ordering/priority via `rank`, but they have no notion of *prerequisite* tasks —
work that must finish before another task can proceed. In practice, agents
already try to encode dependencies by nesting tasks under a "parent that must
finish first", which conflates two different relationships (containment vs.
blocking) and prevents a task from depending on more than one other task.

This change adds a first-class many-to-many `depends_on` relationship between
tasks, exposes it to agents via the `add_task` MCP tool, and surfaces it in the
task view so a user can see and edit a task's dependencies. Additionally,
because the user wants deps to matter (not just be informational), we extend
the `tasks_v` status derivation to compute a new `blocked` status when any
dependency is not yet terminal.

## Design decisions (answered with the user)

- **Deps affect status.** A task with any non-terminal dep is `blocked` and
  `active = false`. Terminal for a dep means `done` or `dropped`.
- **Add-dep UI scope.** Only the "Add parent as dep" shortcut + per-chip `×`
  remove. Arbitrary picker is out of scope for this pass (can add later).
- **Storage.** A dedicated `task_dependencies` join table (composite PK,
  FK-cascade on both sides). Matches the tasks plugin's idiom of putting
  physical tables in `schema_internal.ts` and exposing derived data via the
  `tasks_v` view.

## Files to modify

### Schema

- **`plugins/tasks/server/schema_internal.ts`** — add `_taskDependencies`:
  ```ts
  export const _taskDependencies = pgTable(
    "task_dependencies",
    {
      taskId: text("task_id").notNull().references(() => _tasks.id, { onDelete: "cascade" }),
      dependsOnTaskId: text("depends_on_task_id").notNull().references(() => _tasks.id, { onDelete: "cascade" }),
      createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
      index("task_deps_depends_on_idx").on(t.dependsOnTaskId),
    ],
  );
  ```

- **`plugins/tasks/server/schema.ts`** — extend `tasks_v`:
  1. Add a `hasBlockingDep` fact to the `task_facts` CTE. A dep blocks iff it
     is not terminal; terminal = `droppedAt IS NOT NULL` OR has a completed
     attempt in `attempts_v` (mirrors how `hasCompleted` is defined — keeps us
     out of a `tasks_v`-self-reference):
     ```ts
     hasBlockingDep: sql<boolean>`EXISTS (
       SELECT 1 FROM ${_taskDependencies} td
         JOIN ${_tasks} dep ON dep.id = td.depends_on_task_id
        WHERE td.task_id = ${sql.raw('"tasks"."id"')}
          AND dep.dropped_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${attempts} a
             WHERE a.task_id = dep.id AND a.status = 'completed'
          )
     )`.as("has_blocking_dep"),
     ```
  2. Add `'blocked'` to the `status` CASE between `'done'` and `'need_action'`:
     ```
     WHEN ${_tasks.droppedAt} IS NOT NULL              THEN 'dropped'
     WHEN ${_tasks.heldAt}    IS NOT NULL              THEN 'held'
     WHEN ${facts.hasCompleted}                        THEN 'done'
     WHEN ${facts.hasBlockingDep}                      THEN 'blocked'   -- new
     WHEN ${facts.hasActive} AND ${facts.hasWaiting}   THEN 'need_action'
     ...
     ```
  3. Extend `active` with `AND NOT ${facts.hasBlockingDep}`.
  4. Add a `dependencies: string[]` column using a correlated `ARRAY(SELECT …)`
     subquery ordered by `created_at`, so each `Task` row ships its deps inline
     (small arrays, avoids a second resource).
  5. Extend `TaskStatusSchema` with `"blocked"`.
  6. Extend `TaskSchema` with `dependencies: z.array(z.string())`.

### Server routes

- **`plugins/tasks/server/index.ts`** — register two new routes:
  ```
  "POST   /api/tasks/:id/dependencies": handleAddDependency,
  "DELETE /api/tasks/:id/dependencies/:depId": handleRemoveDependency,
  ```

- **`plugins/tasks/server/internal/handle-dependencies.ts`** *(new file)* —
  handlers, both call `tasksResource.notify()` on success:
  - `handleAddDependency(req, { id })`: body `{ dependsOnTaskId: string }`.
    Reject self-dep (`id === dependsOnTaskId`) and cycles via a
    transitive-closure walk over `_taskDependencies` (analogous to
    `isDescendant` in `handle-update.ts`). `INSERT … ON CONFLICT DO NOTHING`.
  - `handleRemoveDependency(req, { id, depId })`: delete the row; 404 if none
    removed.

### MCP tool

- **`plugins/tasks/server/internal/mcp-tools.ts`** — add `dependencies` param
  to `add_task` and rewrite the description to teach the agent the new
  relationship:
  ```ts
  dependencies: z
    .array(z.string())
    .optional()
    .describe(
      "Task IDs this task depends on (must finish first). The new task will be marked 'blocked' until every dependency is 'done' or 'dropped'."
    ),
  ```
  Handler inserts one `_taskDependencies` row per id after the task row, under
  the same DB transaction if feasible (otherwise sequentially — acceptable
  since new task id has no cycles yet). Validate each id exists; skip/raise
  on unknown ids. Update the top-of-tool description paragraph to clarify the
  split:
  > `parent` places the task in the tree (containment). `dependencies` is the
  > orthogonal blocking relationship — use it to say "finish these other tasks
  > first" without nesting.

### Frontend

- **`plugins/tasks/web/components/task-dependencies.tsx`** *(new file)* — the
  Dependencies section component. Follows the section pattern from
  `task-events.tsx`:
  ```tsx
  <section className="flex flex-col gap-2">
    <div className="flex items-center justify-between">
      <h3 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        Dependencies
      </h3>
      {canAddParent && (
        <Button size="xs" variant="outline" onClick={addParentAsDep}>
          Add parent as dep
        </Button>
      )}
    </div>
    {task.dependencies.length === 0 ? (
      <p className="text-muted-foreground text-sm">No dependencies.</p>
    ) : (
      <ul className="flex flex-wrap gap-2">
        {task.dependencies.map((depId) => (
          <DepChip key={depId} taskId={taskId} depId={depId} />
        ))}
      </ul>
    )}
  </section>
  ```
  - `DepChip` reads the dep's title from `tasksResource`, renders
    `<button>title <span>×</span></button>` (the whole chip opens the dep via
    `Shell.OpenPane(tasksPane({ id: depId }))`; the `×` stops propagation and
    calls `DELETE /api/tasks/:id/dependencies/:depId`).
  - `canAddParent` = task has a `parentId`, parent is not the Conversations
    meta task, parent is not already in `task.dependencies`.
  - `addParentAsDep` = `POST /api/tasks/:id/dependencies` with
    `{ dependsOnTaskId: task.parentId }`.

- **`plugins/tasks/web/components/task-detail.tsx`** —
  1. Render `<TaskDependencies taskId={taskId} />` above `<TaskEvents />`.
  2. Add `blocked` to `STATUS_LABELS` (`"Blocked"`) and `STATUS_CLASSES`
     (e.g. `"bg-zinc-500/15 text-zinc-700 dark:text-zinc-300"` — similar mute
     weight to `held`).

Nothing else needs to change for the web resource: the existing
`tasksResource` already broadcasts the full task row, which now includes
`dependencies` and the extended `status`.

## Functions / utilities to reuse

- `tasksResource.notify()` (`plugins/tasks/server/internal/resources.ts`) —
  broadcast after every mutation so both the mutating task and any tasks that
  depend on it re-render.
- Cycle check pattern: `isDescendant` in
  `plugins/tasks/server/internal/handle-update.ts` — copy the walk-up-parents
  shape for the deps graph.
- `useResource(tasksResource)` + `find(t => t.id === …)` pattern (already used
  in `task-detail.tsx`, `AuthorDisplay`) for resolving dep task titles.
- `ShellCommands.OpenPane(tasksPane({ id }))` to navigate when a chip is
  clicked.
- `<Button size="xs" variant="outline">` primitive for the "Add parent as dep"
  shortcut.

## Migration

Run `./equin build --migration-name add-task-dependencies`. Drizzle will
emit:
1. `CREATE TABLE task_dependencies (…)` with composite PK + FK cascades.
2. `DROP VIEW tasks_v; DROP VIEW attempts_v;` (attempts_v isn't changing but
   tasks_v depends on it, so drizzle-kit may reorder; confirm by inspection and
   hand-edit the generated SQL if dependents drop in the wrong order — see the
   convention note in `server/CLAUDE.md`).
3. Recreate `attempts_v` then `tasks_v` with the new columns.

## Verification

1. `./equin build` — migration applies, server restarts, frontend
   rebuilds.
2. MCP: from any conversation, call `add_task` with `dependencies: ["<some
   existing task id>"]`. New task appears with the dep shown in the view and
   its status is `blocked` (unless the dep is already `done`/`dropped`).
3. UI: open a task with a parent (and no existing parent dep). "Add parent as
   dep" button appears; clicking adds the parent and the button disappears.
   Status flips to `Blocked`.
4. UI: click `×` on a dep chip — dep is removed, status re-derives (back to
   `new`/whatever's appropriate).
5. Cycle guard: try to add A → depends on B, then B → depends on A via the
   POST route (or MCP). Second call returns 400.
6. Terminal dep unblocks: launch an attempt on the dep, let it reach
   `completed` (via a push). Parent task's status should update from `blocked`
   to its natural state (via the existing `tasksResource` notify cascade when
   the push/attempt changes; the view recomputes automatically).
7. `./equin check` — `migrations-in-sync` passes.
