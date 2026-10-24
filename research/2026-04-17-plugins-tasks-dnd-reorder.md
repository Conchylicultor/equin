---
title: Drag-and-drop reordering in the task tree
date: 2026-04-17
category: plugins/tasks
status: draft
---

# Context

The task tree in `plugins/tasks/web/components/tasks-list.tsx` renders a nested list of tasks. Today:

- Siblings are sorted by `createdAt ASC` on the server (`handle-list.ts`, `resources.ts`).
- There is no explicit ordering column on `_tasks` and the PATCH endpoint does not accept `parentId` or ordering fields.
- No drag-and-drop library is installed anywhere in the repo.

We want users to **reorder siblings and reparent tasks** by dragging rows in the tree. Decisions already made with the user:

- Drag supports **reorder + reparent** (drop between rows to reorder, drop onto a row to make it a child).
- Library: **`@dnd-kit`** (core + sortable).
- Ordering storage: **lexicographic fractional rank** (strings like `a`, `aa`, `ab`, `aba`, `ac`), one integer-less write per move.

# High-level approach

1. Add a `rank TEXT NOT NULL` column to `_tasks`. Siblings are uniquely ordered by `(parentId, rank)`.
2. Seed existing rows with ranks derived from their current `createdAt` order, so behavior is unchanged on first boot.
3. Use the well-known [`fractional-indexing`](https://www.npmjs.com/package/fractional-indexing) library (≈1 KB) to generate the rank strings. Its `generateKeyBetween(a, b)` returns a string strictly between `a` and `b` lexicographically — the exact scheme described by the user (`a`, `aa`, `ab`, `aba`, `ac`, …) with a stable reference implementation.
4. Teach `POST /api/tasks` and `PATCH /api/tasks/:id` to accept/compute `rank` and (for PATCH) accept `parentId`.
5. Wire `@dnd-kit` into `TasksList` / `TaskNode`: sortable rows, drop zones between siblings, and a "make child" drop target on the row body. On drop, compute the new `{ parentId, rank }` client-side with `generateKeyBetween` and PATCH once.

The `tasksResource` is already push-based, so after the PATCH notifies, all connected clients rerender with the new order for free.

# Data model

**File:** `plugins/tasks/server/schema_internal.ts`

Add one column to `_tasks`:

```ts
rank: text("rank").notNull(),
```

The derived view `tasks` in `plugins/tasks/server/schema.ts` uses `getTableColumns(_tasks)` so the field surfaces on `Task` automatically. `TaskSchema` (Zod) will pick it up via `createSelectSchema`.

**Indexes:** add a composite index on `(parent_id, rank)` for fast sorted reads:

```ts
(t) => [index("tasks_parent_rank_idx").on(t.parentId, t.rank)]
```

**Migration + seeding.** `./equin build` regenerates migrations from `schema.ts`. Because `rank` is `NOT NULL`, the generated migration will need to seed existing rows. Simplest path:

1. Let drizzle-kit generate the `ALTER TABLE … ADD COLUMN rank text NOT NULL` migration.
2. Hand-edit that migration file to:
   - Add the column as nullable first (`ADD COLUMN rank text`).
   - Backfill via raw SQL using `row_number()` per `parent_id` ordered by `created_at`, converting the row number to a padded base-36 string that `fractional-indexing` can extend cleanly, e.g. `LPAD(TO_HEX(row_number)::text, 8, '0')` wrapped as `'a' || …` so subsequent `generateKeyBetween` calls stay in-charset.
   - `ALTER COLUMN rank SET NOT NULL`.

A worked formula for the seed rank:

```sql
UPDATE tasks t
SET rank = 'a' || LPAD(
  TO_HEX(ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY created_at)::int),
  8, '0'
)
```

(Any deterministic, lex-sorted, `0-9a-z`-only string works; the exact padding is not load-bearing as long as it's unique per parent and the `fractional-indexing` charset is respected.)

# Server changes

### `plugins/tasks/server/internal/resources.ts` and `handle-list.ts`

Change ordering from `asc(tasks.createdAt)` to `asc(tasks.rank)` (with `createdAt` as a defensive tie-break). Both locations must be updated so the push resource and the REST GET return the same order.

### `plugins/tasks/server/internal/handle-create.ts`

When creating a task, compute the rank as the last-rank-plus-one within the target parent:

```ts
const siblings = await db
  .select({ rank: _tasks.rank })
  .from(_tasks)
  .where(eq(_tasks.parentId, parentId ?? null))
  .orderBy(desc(_tasks.rank))
  .limit(1);
const rank = generateKeyBetween(siblings[0]?.rank ?? null, null);
```

### `plugins/tasks/server/internal/handle-update.ts`

Extend the accepted body:

```ts
parentId?: string | null;
rank?: string;
```

Guardrails:

- If `parentId` is provided, reject `parentId === id` and reject `parentId` that is a descendant of `id` (cycle check — single recursive CTE or an in-memory walk of the tasks table).
- If `rank` is provided, accept as-is (trust client-computed rank). No server-side renumber needed.
- Write both into `patch` alongside the existing fields.

# Web changes

### Dependencies

Add to the **root** `package.json` (shared via workspaces):

- `@dnd-kit/core`
- `@dnd-kit/sortable`
- `@dnd-kit/utilities`
- `fractional-indexing`

### `plugins/tasks/web/components/tasks-list.tsx`

Structural changes to the existing file:

1. Wrap the whole list in `<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>`.
   - Sensors: `PointerSensor` with a small activation distance (e.g. 4 px) so clicking the title input still focuses it.
2. Wrap each group of siblings in `<SortableContext items={...} strategy={verticalListSortingStrategy}>` so drag-to-reorder works within a parent.
3. Convert `TaskNode` row into a sortable item via `useSortable({ id: node.id })`. Bind `attributes`, `listeners`, and transform/transition styles to a small **drag handle** on the left of the row (a six-dot icon; only visible on hover to avoid UI noise). The title input stays unaffected.
4. Register three drop zones per row so a single drop event can express all three intents:
   - A thin dropzone ABOVE the row → insert as previous sibling.
   - A thin dropzone BELOW the row → insert as next sibling.
   - The row body itself → drop as a **child** of this row.
   Implemented with `useDroppable` and distinct IDs like `before:<id>`, `after:<id>`, `child:<id>`.

### Drop handling

In `handleDragEnd`, compute the destination from the drop target:

- `before:<target>` → new `parentId = target.parentId`, `rank = generateKeyBetween(prev.rank ?? null, target.rank)`.
- `after:<target>`  → new `parentId = target.parentId`, `rank = generateKeyBetween(target.rank, next?.rank ?? null)`.
- `child:<target>`  → new `parentId = target.id`, `rank = generateKeyBetween(lastChild?.rank ?? null, null)`; also PATCH `expanded: true` on the target if it was collapsed.

Validate before PATCH:

- Drop target is not the dragged node itself.
- Drop target is not a descendant of the dragged node (walk the tree via the same `byId` map already built in `buildTree`).

Issue the PATCH:

```ts
await fetch(`/api/tasks/${draggedId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parentId, rank }),
});
```

No optimistic update is strictly required — the push resource will notify and re-render within a tick — but an optional optimistic local reorder keeps the UI snappy on slow links. Defer unless the UX feels laggy.

### Visuals

- Drag handle: `MdDragIndicator` icon, `opacity-0 group-hover:opacity-60 cursor-grab`.
- Active drag: lower the dragged row's opacity to ~0.4 via the `useSortable` transform; render a `DragOverlay` clone for the floating preview.
- Drop indicators: a 2 px accent-colored bar shown inside `before:` / `after:` zones when hovered; a subtle background highlight for `child:` hover.

# Files to modify

- `plugins/tasks/server/schema_internal.ts` — add `rank` column + index.
- `server/src/db/migrations/<new>` — generated + hand-edited to backfill ranks.
- `plugins/tasks/server/internal/handle-create.ts` — compute rank on create.
- `plugins/tasks/server/internal/handle-update.ts` — accept `parentId`, `rank`; add cycle check.
- `plugins/tasks/server/internal/handle-list.ts` — sort by `rank`.
- `plugins/tasks/server/internal/resources.ts` — sort by `rank` in loader.
- `plugins/tasks/web/components/tasks-list.tsx` — DndContext, SortableContext, drop zones, rank math.
- `package.json` (root) — add `@dnd-kit/*` and `fractional-indexing`.

No plugin boundary changes, no new plugin; this is all internal to `tasks`.

# Verification

After `./equin build`:

1. Load `http://<worktree>.localhost:9000/tasks` and confirm the tree renders in the same order as before the change (seed preserved ordering).
2. Drag a task row up/down within its parent → order updates instantly and persists after a hard refresh.
3. Drag a task onto another task's body → it becomes a child; the target auto-expands.
4. Try dragging a task onto one of its own descendants → PATCH is not issued; UI does not reparent.
5. Create a new task via the inline "Add" button → it lands at the end of its parent; no ordering regression.
6. Open the same conversation in two tabs → reordering in one reflects in the other within a tick (confirms `tasksResource` push path still works).
7. DB sanity: `select id, parent_id, rank from tasks order by parent_id, rank;` shows the expected order.

End-to-end script idea (optional): extend `e2e/screenshot.mjs` to drag the second root task above the first and assert the resulting row order visually.
