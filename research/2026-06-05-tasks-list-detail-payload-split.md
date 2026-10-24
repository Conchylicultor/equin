# Tasks list/detail payload split — stop pushing `description` in the live list

## Context

The runtime profiler flags the `tasks_v` list query (~270ms) and `attempts_v`
(~120ms) as among the slowest live-state loaders on every page load. The request
was to investigate why these *view queries* are slow at this data size.

**They are not.** Measured with `EXPLAIN (ANALYZE, BUFFERS)` against the main
`singularity` DB (2268 tasks, 2096 attempts, 2241 conversations, 1606 pushes)
**and** this worktree's fork, both views execute in **~22ms / ~18ms** warm —
every buffer is a cache hit. The scary planner cost estimates (731k / 258k) never
materialize into real time.

The profiler's "270ms" is the **db span**, which wraps the full `pool.query`
round-trip, not just server execution. The gap decomposes into:

1. **Payload bloat.** The `tasks` resource is `SELECT *` over `tasks_v` →
   **991 KB / 2268 rows, of which 606 KB (61%) is the `description` text column.**
   The list never renders descriptions. This is pushed (`mode: "push"`) to every
   connected tab on every cascade fire.
2. **Event-loop contention.** The cascade `conversationsLive → attempts → tasks`
   fires on every conversation status change, recomputing and rebroadcasting the
   *entire* array. When many loaders fire at once the single Bun thread stalls —
   `[acquire]` (pool checkout) and db spans all balloon to ~390ms at the same
   instant (a head-of-line stall measured by everything queued behind it). The
   `tasks` loader's `[acquire]` alone averages 78ms under this contention.

Field-consumption audit: **exactly one** web component reads `description` from
the bulk array — the detail-pane editor (`task-description.tsx:21`,
`task?.description`). Every other consumer (≈25 sites) reads only list fields
(id, title, status, rank, folderId, dependencies, etc.). A per-id
`GET /api/tasks/:id` endpoint already exists.

This plan addresses **axis 1 (payload size)** via a list/detail split. Axis 2
(stop rebroadcasting all rows on every fine-grained change — row-level delta
sync) is deferred to follow-up task `task-1780657195387-se55nl`.

## Goal

- The bulk `tasks` live resource carries **list-only columns** (drop
  `description`) → ~991 KB → ~385 KB per push (−61%), less transfer/parse, smaller
  WS broadcast to N tabs.
- The detail-pane description editor sources `description` from a **parametrized
  per-id live resource** (`task-detail`), so it stays live across tabs/agents and
  only loads when a detail pane is open.
- Type-safe by construction: the list payload type loses `description`, so the
  single consumer that needs it **fails to compile** until rewired — no silent
  blank-and-erase risk.

`attempts_v` has no large text column to move (its ~365 KB is evenly spread; no
single field dominates), so the split does not apply to it. Attempt-side
improvement is folded into the delta follow-up.

## Design

Mirror the canonical parametrized-resource pattern from `page-blocks`
(`plugins/page/plugins/editor/{core,server,web}` — `blocksResource` /
`blocksLiveResource`, keyed by `{ documentId }`).

### 1. Schema: split list-item from full task

`plugins/tasks-core/server/internal/schema.ts` (after `TaskSchema`, ~line 223):

```ts
/** List-view projection: full task minus the heavy `description` column. */
export const TaskListItemSchema = TaskSchema.omit({ description: true });
export type TaskListItem = z.infer<typeof TaskListItemSchema>;
```

`Task` (with `description`) stays the full type used by the detail path and
`getTask`.

### 2. Server: trim the list loader, add the detail resource

`plugins/tasks-core/server/internal/resources.ts`:

- **List loader** (`tasksResource`, line 84) — replace the bare `db.select()`
  (= `SELECT *`) with an explicit projection of every `tasks` view column
  **except `description`**, and retype to `TaskListItem[]`. Columns to keep:
  `id, folderId, groupId, title, author, droppedAt, heldAt, expanded, rank,
  createdAt, updatedAt, status, active, finishedAt, dependencies`.

- **New detail resource** (mirror `blocksLiveResource`):

```ts
export const taskDetailResource = defineResource<Task | null, { id: string }>({
  key: "task-detail",
  mode: "push",
  schema: TaskSchema.nullable(),
  loader: async ({ id }) =>
    (await db.select().from(tasks).where(eq(tasks.id, id)))[0] ?? null,
});
```

Returns the full `tasks_v` row (incl. `description`) for one id. Uses `eq` from
`drizzle-orm`.

- **Notify wiring** — `description` only changes via a direct single-task
  mutation, so notify the detail resource at the same single-task sites in
  `plugins/tasks-core/server/internal/mutations/tasks.ts` that already call
  `tasksResource.notify()` for a specific task (the `updateTask` /
  drop / hold paths): add `taskDetailResource.notify({ id })`.
  > Note: the detail payload's *derived* fields (status/finishedAt) only refresh
  > on these notifies, not on the attempts cascade. That is correct here because
  > the **list resource remains the authoritative source for derived/status
  > fields** (the header reads them via `useTask`); the detail resource exists
  > solely to supply `description`. If a future detail-only field is derived from
  > the attempts cascade, add a `dependsOn` edge then.

- Export `taskDetailResource` from the tasks-core barrels (mirror how
  `tasksResource` is exported) and declare it via `Resource.Declare` in
  `plugins/tasks-core/server/index.ts` alongside the existing resources.

### 3. Client: descriptor + consumer rewrite

- `plugins/tasks/core/resources.ts` — retype `tasksResource` to
  `TaskListItem[]` (line 25), and add the detail descriptor (mirror
  `blocksResource`):

```ts
export const tasksResource =
  resourceDescriptor<TaskListItem[]>("tasks", z.array(TaskListItemSchema), []);

export const taskDetailResource =
  resourceDescriptor<Task | null, { id: string }>("task-detail", TaskSchema.nullable(), null);
```

  `useTask(id)` (`plugins/tasks/web/client.ts:45`) now returns
  `TaskListItem | null`. This is the forcing function — the only `.description`
  reader breaks.

- `plugins/tasks/plugins/task-description/web/components/task-description.tsx`:
  keep `useTask(taskId)` for the cheap fields it still needs (`title` for the
  disabled check, existence gate), and source `description` from the detail
  resource:

```tsx
const task = useTask(taskId);                                   // list item (no description)
const detail = useResource(taskDetailResource, { id: taskId }); // full task, live
const descField = useEditableField({
  value: detail.data?.description ?? "",
  onSave: (v) => patchTask(taskId, { description: v }),
});
```

  **Correctness checkpoint (the silent-erase risk):** do not let the editor
  autosave its empty placeholder before the detail payload arrives. Gate the
  `DescriptionView` render on the detail being loaded (e.g. render `null` /
  skeleton until `detail.data !== undefined`), analogous to the existing
  `if (!task) return null`. Verify `useEditableField`'s self-echo suppression
  handles the initial seed without firing `onSave`.

  `buildLaunchRequest` already fetches `fresh` via `getTaskEndpoint`, so the
  launch-prompt path is unaffected by dropping `description` from the list.

## Files to modify

- `plugins/tasks-core/server/internal/schema.ts` — add `TaskListItemSchema` / `TaskListItem`.
- `plugins/tasks-core/server/internal/resources.ts` — trim list loader, add `taskDetailResource`.
- `plugins/tasks-core/server/internal/mutations/tasks.ts` — `taskDetailResource.notify({ id })` at single-task mutation sites.
- `plugins/tasks-core/server/index.ts` — `Resource.Declare(taskDetailResource)`.
- `plugins/tasks-core/core` barrel + `plugins/tasks/core/resources.ts` — export descriptors, retype `tasksResource`, add `taskDetailResource`.
- `plugins/tasks/plugins/task-description/web/components/task-description.tsx` — consume the detail resource.

## Out of scope (follow-up)

- **Axis 2 — row-level delta sync** (task `task-1780657195387-se55nl`): stop
  recomputing/rebroadcasting all ~2268 tasks / ~2096 attempts on every cascade
  fire; ship only changed rows. Covers the contention spikes and the attempts
  side. Survey Rocicorp Zero / ElectricSQL / Replicache / normalized GraphQL
  caches; decide whether the live-state primitive grows a first-class delta mode.

## Measured outcome (implemented 2026-06-05)

Verified on this worktree's backend (`/api/debug/profiling/runtime`, warm):

- **Payload.** `tasks` list JSON dropped from ~1.67 MB to **924 KB** — `description`
  totals ~747 KB across 1496/2268 tasks, ~**45%** of the push (the plan's "61% /
  385 KB" was raw column bytes; in JSON the verbose keys/ISO dates/arrays inflate
  the non-description fields, so description is a smaller *share* of the wire
  payload — but the absolute ~747 KB removed per push is what matters).
- **`tasks` loader:** ~214–296 ms → **avg 33 ms / last 25 ms**.
- **`tasks_v` db span:** ~56 ms last / 340 ms max → **14 ms last / 35 ms max** (the
  query label no longer contains `description`).
- **`task-detail` resource:** **7–11 ms**, and only runs when a detail pane is open.
- Detail pane renders the full description (no blank/erase); list tree unaffected.

## Verification

1. `./equin build` (from this worktree).
2. **Payload shrank:** in `mcp__singularity__get_runtime_profile` (kind `db`),
   the `tasks_v` SELECT no longer lists `"description"` in its label, and its
   `avgMs` / transfer drops. Cross-check column count by hitting
   `GET /api/resources/tasks` and confirming `description` is absent from rows.
3. **Detail still works (and is live):** open a task detail pane at
   `http://att-1780611262-di8w.localhost:9000`, confirm the description renders,
   edits save (`PATCH /api/tasks/:id`), and a non-empty description does **not**
   blank on first open. Open the same task in a second tab and confirm an edit in
   one propagates to the other (live push via `task-detail`).
4. **No silent erase:** open a task with a long description, click into the
   detail, immediately click away without typing — confirm the stored
   description is intact (`mcp__singularity__query_db`:
   `SELECT length(description) FROM tasks WHERE id = '<id>'`).
5. **Typecheck/boundaries:** `./equin check` passes (`eslint`,
   plugin-boundaries, `plugins-doc-in-sync`).
6. Use `e2e/screenshot.mjs --click` to capture before/after of the detail pane
   description editor to confirm behavior.
