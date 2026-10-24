# Add "Hold" task status

## Context

Today a task can only be **Dropped** — which reads as "this is done / abandoned, won't come back". There's no way to say "pause this, I might pick it up later" without losing it or leaving it noisy in the list.

Add a **Hold** status alongside Drop. Hold means *temporarily paused but still intended*. Drop means *abandoned / not coming back*. The two are mutually exclusive — toggling one clears the other — so the UI surface is "a task is either active, held, dropped, or in one of the derived progress states".

## Design

### Mutual exclusion

`heldAt` and `droppedAt` are separate timestamps, but the API and UI enforce that setting one clears the other. This keeps the schema uniform (timestamps gate statuses, like `droppedAt` does today) while preventing a confusing "held + dropped" state.

Status precedence in the view CASE: `dropped` → `held` → `done` → `in_progress` → `attempted` → `new`. Drop wins over Hold only as a defensive fallback — in practice the mutual-exclusion logic prevents both from being set.

### Visual differentiation

Follow the existing colored-badge pattern from `plugins/conversations/.../status/web/components/status-badge.tsx:4-9`:

- **Held** → amber (`bg-amber-500/15 text-amber-700 dark:text-amber-300`) — matches the "waiting" semantic already used elsewhere in the app.
- **Dropped** → muted gray (`bg-muted text-muted-foreground/60 italic`) — matches "gone".
- Other statuses keep today's `bg-muted` styling.

## Files to change

### 1. `plugins/tasks/server/schema_internal.ts:14-25`

Add the column next to `droppedAt`:

```ts
heldAt: timestamp("held_at", { withTimezone: true }),
```

### 2. `plugins/tasks/server/schema.ts`

**View CASE (lines 125-133)** — add the held branch between dropped and done:

```ts
status: sql<"new" | "in_progress" | "attempted" | "done" | "held" | "dropped">`
  CASE
    WHEN ${_tasks.droppedAt} IS NOT NULL   THEN 'dropped'
    WHEN ${_tasks.heldAt}    IS NOT NULL   THEN 'held'
    WHEN ${facts.hasCompleted}             THEN 'done'
    WHEN ${facts.hasActive}                THEN 'in_progress'
    WHEN ${facts.hasAttempt}               THEN 'attempted'
    ELSE                                        'new'
  END
`.as("status"),
```

**`active` derivation (lines 134-138)** — a held task is not active:

```ts
active: sql<boolean>`(
  ${_tasks.droppedAt} IS NULL
  AND ${_tasks.heldAt} IS NULL
  AND NOT ${facts.hasCompleted}
  AND ${facts.hasActive}
)`.as("active"),
```

**`TaskStatusSchema` enum (lines 151-157)** — add `"held"`:

```ts
export const TaskStatusSchema = z.enum([
  "new",
  "in_progress",
  "attempted",
  "done",
  "held",
  "dropped",
]);
```

**`TaskSchema` (lines 169-177)** — add the nullable date override:

```ts
heldAt: z.coerce.date().nullable(),
```

### 3. `plugins/tasks/server/internal/handle-update.ts:12-26`

Accept `hold?: boolean` alongside `drop`. Enforce mutual exclusion: setting one to `true` clears the other. Setting to `false` clears only itself.

```ts
const body = (await req.json().catch(() => ({}))) as {
  title?: string;
  description?: string | null;
  drop?: boolean;
  hold?: boolean;
  expanded?: boolean;
};
// ...
if (typeof body.drop === "boolean") {
  patch.droppedAt = body.drop ? new Date() : null;
  if (body.drop) patch.heldAt = null;
}
if (typeof body.hold === "boolean") {
  patch.heldAt = body.hold ? new Date() : null;
  if (body.hold) patch.droppedAt = null;
}
```

### 4. `plugins/tasks/web/components/task-detail.tsx`

- Extend local `Task` status union (line 9): add `"held"`.
- Extend `STATUS_LABELS` (lines 13-19): `held: "Held"`.
- Add a `STATUS_CLASSES` map (new, next to `STATUS_LABELS`) replacing the inline `bg-muted` on line 140:
  ```ts
  const STATUS_CLASSES: Record<Task["status"], string> = {
    new: "bg-muted",
    in_progress: "bg-muted",
    attempted: "bg-muted",
    done: "bg-muted",
    held: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    dropped: "bg-muted text-muted-foreground/60 italic",
  };
  ```
- Extend `save`'s patch type (line 44) to include `hold: boolean`.
- Add `toggleHold` next to `toggleDrop` (lines 83-86):
  ```ts
  const toggleHold = () => {
    if (!task) return;
    void save({ hold: task.status !== "held" });
  };
  ```
- Render a "Hold" / "Resume" button alongside "Drop task" / "Undrop" (lines 143-149). Labels: `task.status === "held" ? "Resume" : "Hold"`. Use the same `variant` pattern (`secondary` when active, `outline` otherwise).

### 5. Migration

Run `./equin build` — it calls `drizzle-kit generate` to emit the migration for the new `held_at` column and the regenerated `tasks_v` view. Do **not** run drizzle-kit manually (per `CLAUDE.md`). Commit the generated migration file with the rest of the change.

## What stays the same

- `tasks-list.tsx` renders the tree by title only and never reads `status`, so no filtering/list changes.
- `handle-list.ts` / `resources.ts` return all tasks — held tasks will appear in the sidebar like any other, which matches the "don't lose it" intent.
- No changes to `plugins/tasks/server/internal/handle-create.ts` — new tasks default to `heldAt: null`.

## Verification

1. `./equin build` — must succeed, generating a new migration and restarting the server.
2. `./equin check` — `migrations-in-sync` should pass (the new migration file lands in the repo).
3. In the app at `http://<worktree>.localhost:9000`:
   - Open a task → click "Hold" → badge turns amber "Held", button now reads "Resume". Reload: state persists.
   - Click "Resume" → badge returns to prior derived status (`new` / `attempted` / etc.).
   - On a held task, click "Drop task" → badge flips to "Dropped" (gray italic); `heldAt` is cleared.
   - On a dropped task, click "Hold" → badge flips to "Held"; `droppedAt` is cleared.
   - Check DB: `select id, held_at, dropped_at from tasks where id = …` — never both non-null simultaneously.
4. `bun run typecheck` (or whatever the build does) — the widened `TaskStatus` union must flow through without type errors.
