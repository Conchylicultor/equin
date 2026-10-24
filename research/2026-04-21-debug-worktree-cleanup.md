# Debug Plugin: Worktree Cleanup

## Context

Every Claude agent run creates two resources that must be cleaned up when the work is done:

1. A git worktree at `<repo-root>/.claude/worktrees/<attempt-id>/`
2. A Postgres DB fork named after the attempt ID (e.g., `claude-1776757479-a1b2`)

Over time, completed or abandoned attempts accumulate stale worktrees and DB forks that waste disk space and Postgres connections. There is currently no tooling for auditing or removing them.

This plugin adds a "Worktree Cleanup" entry to the existing Debug sidebar. It shows a table of every attempt alongside its git hygiene status, task status, disk usage, and age, and provides per-row delete actions with appropriate safety gates.

---

## Data Model

### Source tables / views

| Source | Key columns used |
|--------|-----------------|
| `_attempts` table | `id` (= DB fork name), `taskId`, `worktreePath`, `createdAt` |
| `tasks_v` view | `id`, `title`, `status` |
| `attempts_v` view | `id`, `status` |

### Git hygiene fields (computed server-side per row, in parallel)

| Field | Shell command | Condition |
|-------|--------------|-----------|
| `dirExists` | `fs.stat(<path>)` | `true` if directory is present on disk |
| `unpushedCount` | `git -C <path> log origin/main..HEAD --oneline` | number of lines returned |
| `isDirty` | `git -C <path> status --porcelain` | `true` if output is non-empty (staged, unstaged, untracked) |
| `diskUsage` | `du -sh <path>` | human-readable string, e.g. `"1.2G"` |

A worktree is **clean** iff `unpushedCount === 0 AND isDirty === false`.
A worktree is **safe to delete** iff it is clean AND `dirExists === true`.

Per-row git errors (e.g. broken worktree state) are caught and treated as `isDirty: true` (fail-safe).

### Per-row response shape

```ts
type WorktreeEntry = {
  attemptId: string;           // = DB fork name
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  attemptStatus: AttemptStatus;
  worktreePath: string;
  createdAt: string;           // ISO 8601
  dirExists: boolean;
  unpushedCount: number;
  isDirty: boolean;
  diskUsage: string | null;    // null when dirExists === false
  isSafe: boolean;             // clean && dirExists
};
```

---

## Files

### New plugin: `plugins/debug/plugins/worktree-cleanup/`

Follows the structure of `plugins/debug/plugins/db-backup/` exactly.

```
web/
  index.ts                        ← Debug.Item registration
  views.tsx                       ← PaneDescriptor
  components/
    worktree-cleanup-panel.tsx    ← all UI state
server/
  index.ts                        ← route registration
  internal/
    handle-list.ts                ← GET /api/debug/worktrees
    handle-delete.ts              ← DELETE /api/debug/worktrees/:id
```

**`web/index.ts`** — registers `Debug.Item`:
- `id: "worktree-cleanup"`, `title: "Worktree Cleanup"`, icon from react-icons/md
- `onClick: () => ShellCommands.OpenPane(worktreeCleanupPane())`

**`web/views.tsx`** — exports `worktreeCleanupPane(): PaneDescriptor` with path `/debug/worktree-cleanup`.

**`server/index.ts`** — registers two routes: `GET /api/debug/worktrees` and `DELETE /api/debug/worktrees/:id`. The bulk action reuses `DELETE /api/debug/worktrees/:id` in a client-side loop — no dedicated bulk endpoint needed (see Bulk Delete below).

**`server/internal/handle-list.ts`**:
1. Join `_attempts` with `tasks_v` and `attempts_v` via Drizzle, ordered by `createdAt DESC`
2. `Promise.all` git hygiene checks for all rows in parallel
3. Use `GIT` constant from `server/src/worktree.ts` for all git spawns
4. Return `{ ok: true, entries: WorktreeEntry[] }`

**`server/internal/handle-delete.ts`**:
1. Look up attempt by `id` → 404 if not found
2. If `dirExists`: call `removeWorktree(attempt.worktreePath)` — return 500 on failure, do NOT proceed to DB drop
3. Call `dropDatabase(id)` from `plugins/conversations/server/internal/db-fork.ts`
4. Return `{ ok: true }` — does NOT delete `_attempts` or task rows (history preserved)

### Modified files

**`server/src/worktree.ts`** — add one new exported function:

```ts
export async function removeWorktree(wtPath: string): Promise<void> {
  const repoRoot = await ensureMainWorktreeRoot();
  const proc = Bun.spawn(
    [GIT, "-C", repoRoot, "worktree", "remove", wtPath, "--force"],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git worktree remove failed: ${err}`);
  }
}
```

`--force` is used because by the time the UI calls delete, the user has already confirmed any dirty state.

**`server/src/plugins.ts`** — import and register `worktreeCleanupPlugin` after `dbBackupPlugin`.

**`web/src/plugins.ts`** — import and register `worktreeCleanupPlugin` after `dbBackupPlugin`.

---

## API Contract

### `GET /api/debug/worktrees`

**Response 200:** `{ ok: true; entries: WorktreeEntry[] }`
**Response 500:** `{ ok: false; error: string }`

### `DELETE /api/debug/worktrees/:id`

**URL param:** `id` — attempt ID (= DB fork name)
**Response 200:** `{ ok: true }`
**Response 404:** `{ ok: false; error: "Attempt not found" }`
**Response 500:** `{ ok: false; error: string }`

### Bulk delete (client-side)

No dedicated bulk endpoint. The "Delete N safe" button fires `DELETE /api/debug/worktrees/:id` for each ID in parallel (`Promise.allSettled`). The UI collects results and shows a summary: "Deleted 4 worktrees" or "Deleted 3, 1 error". Individual row errors appear inline. List auto-refreshes on completion.

This keeps the server simple and makes the endpoint reusable for any future selection strategy (e.g. checkboxes).

---

## UI Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Worktree Cleanup                          [Delete 4 safe]      [Refresh]    │
│  12 worktrees · 4 safe to delete · ~8.3 GB total                            │
├─────────────┬──────────────┬───────┬──────────┬──────────┬───────────────── ┤
│ Task        │ Branch       │ Age   │ Disk     │ Dirty?   │                   │
├─────────────┼──────────────┼───────┼──────────┼──────────┼───────────────── ┤
│ Fix login   │ claude-web/  │ 3d    │ 612 MB   │ clean    │ Delete            │
│ [done]      │ abc          │       │          │          │                   │
├─────────────┼──────────────┼───────┼──────────┼──────────┼───────────────── ┤
│ Add OAuth   │ claude-web/  │ 1d    │ 1.1 GB   │ ⚠ 2      │ Delete            │
│ [attempted] │ def          │       │          │ unpushed │                   │
├─────────────┼──────────────┼───────┼──────────┼──────────┼───────────────── ┤
│ Refactor    │ (missing)    │ 7d    │ —        │ (no dir) │ Drop DB           │
│ [dropped]   │              │       │          │          │                   │
└─────────────┴──────────────┴───────┴──────────┴──────────┴─────────────────┘
```

**Summary line** — computed client-side: total count, safe-to-delete count, parsed disk total.

**"Delete N safe" button** (top bar, next to Refresh):
- Label shows the count: "Delete 4 safe" (disabled and shows "Delete 0 safe" when count is 0)
- Fires `DELETE /api/debug/worktrees` (bulk endpoint)
- During the operation the button shows a spinner and is disabled; individual rows in the safe set also show spinners
- On completion, shows a toast-style result: "Deleted 4 worktrees" or "Deleted 3, 1 error" with inline error detail
- Then auto-refreshes the list

**Per-row action button variants:**
1. **Safe** (`isSafe === true`): "Delete" fires `DELETE /api/debug/worktrees/:id` immediately
2. **Dirty** (`isSafe === false`, `dirExists === true`): "Delete" shows inline confirmation — "Has unpushed commits or uncommitted changes. Delete anyway?" + "Confirm Delete"
3. **Missing directory** (`dirExists === false`): "Drop DB" fires `DELETE` immediately (server skips git step)

**State**: plain `useState`/`useEffect` + manual `fetch` (same pattern as `db-backup-panel.tsx`). Per-row spinner during delete. Inline error text on row failure. Refresh button re-fetches the full list.

---

## Verification

1. `./equin build` completes without TypeScript errors.
2. Debug sidebar shows "Worktree Cleanup" item; clicking opens the pane.
3. `GET /api/debug/worktrees` returns all attempts with correct git hygiene fields.
4. Summary line totals match manual count.
5. Dirty indicator: add an uncommitted file in a worktree → row shows dirty; after committing, Refresh → clean.
6. Unpushed count: add a committed-not-pushed commit → shows count; after pushing, Refresh → 0.
7. Safe delete: click Delete → `git worktree list` no longer includes path; `psql \l` no longer lists the DB; `_attempts` row still exists.
8. Dirty delete: dismiss confirmation → no change; confirm → cleanup proceeds despite dirty state.
9. Missing directory: manually `rm -rf` a worktree → row shows "Drop DB"; clicking drops only the DB.
10. `removeWorktree` is exported from `server/src/worktree.ts` with no TypeScript errors.
11. Bulk delete: click "Delete N safe" → fires parallel DELETE calls for all safe IDs; dirty/missing-dir rows remain; result summary shown; list auto-refreshes.
12. Bulk delete partial failure: one failing deletion does not block the others; error count shown in summary; failed rows show inline errors.
