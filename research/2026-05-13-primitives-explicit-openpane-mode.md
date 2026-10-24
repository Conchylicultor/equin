# Explicit `openPane` mode — remove implicit default behavior

## Context

`openPane()` and `useOpenPane()` currently accept an optional `opts` object. When callers omit `opts` entirely, the navigation behavior is determined implicitly by the internal algorithm — different for standalone calls vs. hook calls. This makes it impossible to reason about what a given `openPane(…)` call will do at a glance, and lets callers accidentally use the wrong mode.

**Current implicit behaviors:**

| Context | No opts (implicit) | With `{ root: true }` | With `{ replace: true }` |
|---|---|---|---|
| Standalone `openPane` | Insert at rightmost valid position per `after` constraints + `validateChain` (for root panes, emergently replaces the whole screen) → becomes `"root"` | `buildFreshChain` always → becomes `"root"` | not available |
| `useOpenPane` hook | Caller-aware "open right": truncate after caller, append target → becomes `"push"` | `buildFreshChain` always → becomes `"root"` | Swap caller's own slot params in-place → becomes `"swap"` |

The goal: make `opts` required and use a `mode` discriminant so every call site declares its intent explicitly. Remove the "default" code paths.

---

## Proposed API

### New type

```ts
// Exported from the pane barrel
export type PaneOpenMode = "root" | "push" | "swap";
```

### `openPane` (standalone, no caller context)

```ts
export function openPane(
  target: PaneObject<any, any, any>,
  params: Record<string, string>,
  opts: { mode: "root" },   // required, only "root" makes sense without caller context
): void
```

### `useOpenPane` (hook, caller-aware)

```ts
export function useOpenPane(): (
  target: PaneObject<any, any, any>,
  params: Record<string, string>,
  opts: { mode: "root" | "push" | "swap" },  // required
) => void
```

### Mode semantics

| Mode | Available on | Behavior |
|---|---|---|
| `"root"` | both | `buildFreshChain` unconditionally — replaces the whole visible screen with a fresh chain rooted at `target`. Use for sidebar nav items and "promote/expand" actions. |
| `"push"` | hook only | Caller-aware "open right": truncate the chain after the caller's column, append `target`. Also handles the "wrap left" case automatically when `target` is a structural prerequisite of the caller's pane. Use for in-component navigation (list rows, chips, toolbar buttons). |
| `"swap"` | hook only | Replace the caller's own column's params in-place (same pane type), truncating any children. Use when switching which entity is shown in the same column (e.g. navigating from one task to another in the task-detail column). |

Remove the `append` option entirely — it has zero production call sites.

The internal `openPaneImpl` signature stays unchanged as an implementation detail. `promote()` on `PaneObject` already calls `openPaneImpl` directly with `{ root: true }` and is already semantically explicit — no change needed.

---

## Files to modify

### Core implementation

**`plugins/primitives/plugins/pane/web/pane.ts`**

- Add `export type PaneOpenMode = "root" | "push" | "swap"`.
- Change `openPane`'s `opts` from `opts?: { root?: boolean; append?: boolean }` to `opts: { mode: "root" }`. Internally: call `openPaneImpl(target._internal, params, { root: true })`.
- In `useOpenPane`'s returned callback: change `opts?` to `opts: { mode: "root" | "push" | "swap" }`.
  - `mode: "root"` → fast-path to `openPaneImpl(..., { root: true })` (same as current `opts?.root` branch).
  - `mode: "push"` → existing "open right" / "wrap left" logic (previously the final `else` branch).
  - `mode: "swap"` → existing `opts?.replace` logic.
- Remove `append` from all types and branches.

**`plugins/primitives/plugins/pane/web/index.ts`**

- Add `PaneOpenMode` to the `export type { … }` block.

---

### Call site migrations (~55 files)

#### Standalone `openPane` → `{ mode: "navigate" }` (24 files)

All standalone `openPane` callers want "root" — either explicit `{ root: true }` or sidebar nav items where the insert+validateChain behavior produces the same result.

| File | Current | New |
|---|---|---|
| `plugins/agents/web/index.ts` | `openPane(agentsRootPane, {})` | `openPane(agentsRootPane, {}, { mode: "root" })` |
| `plugins/agents/web/components/expand-agent-button.tsx` | `openPane(agentDetailPane, { id }, { root: true })` | `openPane(agentDetailPane, { id }, { mode: "root" })` |
| `plugins/apps/plugins/deploy/plugins/servers/web/panes.tsx` | `openPane(serverDetailPane, { serverId: id })` | `openPane(serverDetailPane, { serverId: id }, { mode: "root" })` |
| `plugins/apps/plugins/forge/plugins/catalog/web/index.ts` | `openPane(catalogPane, {})` | `openPane(catalogPane, {}, { mode: "root" })` |
| `plugins/apps/plugins/forge/plugins/publish/web/index.ts` | `openPane(publishPane, {})` | `openPane(publishPane, {}, { mode: "root" })` |
| `plugins/auth/plugins/google/web/index.ts` | `openPane(googleSetupPane, {})` | `openPane(googleSetupPane, {}, { mode: "root" })` |
| `plugins/auth/web/index.ts` | `openPane(accountsPane, {})` | `openPane(accountsPane, {}, { mode: "root" })` |
| `plugins/code-explorer/web/index.ts` | `openPane(globalFileTreePane, { worktree: "main" })` | `openPane(globalFileTreePane, { worktree: "main" }, { mode: "root" })` |
| `plugins/config/web/index.ts` | `openPane(settingsPane, {})` | `openPane(settingsPane, {}, { mode: "root" })` |
| `plugins/conversations-recover/web/index.ts` | `openPane(recoveryPane, {})` | `openPane(recoveryPane, {}, { mode: "root" })` |
| `plugins/conversations/…/side-task/web/components/expand-task-button.tsx` | `openPane(taskDetailPane, { taskId }, { root: true })` | `openPane(taskDetailPane, { taskId }, { mode: "root" })` |
| `plugins/conversations/…/conversations-view/web/components/conversation-list.tsx` | `openPane(conversationPane, { convId: id }, { root: true })` | `openPane(conversationPane, { convId: id }, { mode: "root" })` |
| `plugins/debug/plugins/broadcasts/web/index.ts` | `openPane(broadcastsPane, {})` | `openPane(broadcastsPane, {}, { mode: "root" })` |
| `plugins/debug/plugins/claude-cli-calls/web/index.ts` | `openPane(claudeCliCallsPane, {})` | `openPane(claudeCliCallsPane, {}, { mode: "root" })` |
| `plugins/debug/plugins/db-backup/web/index.ts` | `openPane(dbBackupPane, {})` | `openPane(dbBackupPane, {}, { mode: "root" })` |
| `plugins/debug/plugins/logs/web/index.ts` | `openPane(logsPane, {})` | `openPane(logsPane, {}, { mode: "root" })` |
| `plugins/debug/plugins/memory/web/index.ts` | `openPane(memoryPane, {})` | `openPane(memoryPane, {}, { mode: "root" })` |
| `plugins/debug/plugins/profiling/web/index.ts` | `openPane(profilingPane, {})` | `openPane(profilingPane, {}, { mode: "root" })` |
| `plugins/debug/plugins/queue/web/index.ts` | `openPane(queuePane, {})` | `openPane(queuePane, {}, { mode: "root" })` |
| `plugins/debug/plugins/worktree-cleanup/web/index.ts` | `openPane(worktreeCleanupPane, {})` | `openPane(worktreeCleanupPane, {}, { mode: "root" })` |
| `plugins/events-test/web/index.ts` | `openPane(eventsTestPane, {})` | `openPane(eventsTestPane, {}, { mode: "root" })` |
| `plugins/stats/web/index.ts` | `openPane(statsPane, {})` | `openPane(statsPane, {}, { mode: "root" })` |
| `plugins/tasks/plugins/task-detail/web/index.ts` | `openPane(tasksRootPane, {})` | `openPane(tasksRootPane, {}, { mode: "root" })` |
| `plugins/welcome/web/components/welcome-view.tsx` | `openPane(conversationPane, { convId: name }, { root: true })` | `openPane(conversationPane, { convId: name }, { mode: "root" })` |

#### `useOpenPane` with no opts → `{ mode: "push" }` (~45 files)

All `useOpenPane` call sites that currently pass no opts get `{ mode: "push" }`. These span ~45 components; file list from the exploration:

`active-data/attempt/web/components/attempt-chip.tsx`, `active-data/conv/web/components/conv-chip.tsx`, `active-data/plugin-link/web/components/plugin-link-chip.tsx` (×2), `active-data/task-link/web/components/task-link-chip.tsx` (×2), `active-data/task/web/components/task-card.tsx` (×2), `agents/web/components/agent-avatar-title-prefix.tsx`, `agents/web/components/agent-launches.tsx`, `agents/web/components/agents-list.tsx`, `agents/web/components/system-folder.tsx`, `apps/plugins/deploy/plugins/servers/web/components/servers-list.tsx` (×2), `apps/plugins/forge/plugins/catalog/web/components/plugin-chip.tsx`, `apps/plugins/forge/plugins/publish/web/components/publish-view.tsx`, `attempt-view/web/components/attempt-pane.tsx`, `attempt-view/web/components/attempt-switch-button.tsx`, `auth/web/components/default-provider-row.tsx`, `build/web/components/build-button.tsx`, `code-explorer/web/components/conv-tree-button.tsx`, `conversations/…/docs-button.tsx`, `conversations/…/file-peek-pane.tsx` (×2), `conversations/…/review-button.tsx`, `conversations/…/commits-chip.tsx`, `conversations/…/commits-graph-body.tsx`, `conversations/…/add-task-tool-view.tsx`, `conversations/…/tool-file-path.tsx`, `conversations/…/user-text-row.tsx`, `conversations/…/code-enhancer.tsx`, `conversations/…/file-links-enhancer.tsx`, `conversations/…/img-enhancer.tsx`, `conversations/…/expand-to-tasks-action.tsx`, `conversations/…/tasks-button.tsx`, `conversations/…/terminal-button.tsx` (×2), `conversations/…/summarize-button.tsx`, `plugin-meta/…/public-api-section.tsx` (the non-replace call), `primitives/plugins/launch/web/components/launch-buttons.tsx`, `stats/…/top-conversations-table.tsx`, `tasks/…/task-description.tsx`, `tasks/…/task-detail/web/panes.tsx`, `tasks/…/task-events.tsx`.

#### `useOpenPane` with `{ replace: true }` → `{ mode: "swap" }` (5 files)

| File |
|---|
| `plugins/conversations/…/side-task/web/components/side-task-body.tsx` |
| `plugins/plugin-meta/…/public-api-section.tsx` |
| `plugins/plugin-meta/…/sub-plugins-section.tsx` |
| `plugins/tasks/…/task-dependencies.tsx` |
| `plugins/tasks/…/task-graph.tsx` |
| `plugins/tasks/…/task-header/author-display.tsx` |

---

## Behavior change note

Sidebar nav items previously got the "insert at position 0, let `validateChain` drop the old root" behavior (emergent from Branch B). With `"root"`, they always call `buildFreshChain`. Net user-visible result is identical (same screen shown) with one edge case: if the user is already on a root pane, the old code was a no-op (same params early return in Branch A), while `"root"` rebuilds the chain unconditionally. This is acceptable — same URL → same rendered state, just an extra `setChain` call. If this causes visible jank, a same-URL short-circuit can be added inside the `"root"` code path as an optimization.

---

## Verification

```bash
# TypeScript must have zero errors after migration
./equin build

# Spot check: clicking sidebar nav items in the UI still navigates correctly
# Spot check: clicking a task row still opens task detail to the right
# Spot check: clicking a dependency chip inside task-detail replaces the column (swap mode)
```
