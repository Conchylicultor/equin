---
date: 2026-04-16
category: plugins
title: Conversation review mode (file-by-file diff view)
---

# Review mode for the conversation view

## Context

Today the conversation view has a small `edited-files-button` toolbar item that opens a middle pane with a flat file list. Reviewing what an agent actually changed still requires opening files one-at-a-time in the right pane and reading per-file diffs.

We want a true "review mode" — a single button that surfaces the size of the change at a glance (file count + line delta), and when clicked, swaps the terminal area for a full file-by-file diff scroll, à la GitHub's PR Files Changed tab. This makes reviewing a worktree's changes the primary workflow, not a side activity.

User-confirmed scope decisions:
- New button **coexists** with the existing `edited-files-button` (sibling on `Code.ToolbarButton`).
- v1 statuses: `new` / `modified` / `deleted`. **No rename detection** ("moved") for v1.
- State is **in-memory per conversation**, just like existing middle/right panes.
- Right pane is **hidden** while review mode is active — review owns the full content area.

## Approach

A new plugin `review` is added as a sibling of `edited-files-button` under the existing `code` meta-plugin. It contributes:
- a `Code.ToolbarButton` (the entry point), and
- a "main view" descriptor that replaces the terminal column when active.

To support replacing the terminal, `conversation-view` gains a third pane primitive — `Conversation.OpenMainView` — that mirrors the existing `OpenMiddlePane` / `OpenRightPane` commands. When set, the descriptor's component is rendered instead of the terminal (and the right pane is hidden).

Server-side, the existing `edited-files` resource is extended to include per-file line counts, so the toolbar button can show `N files +123 -45` without an extra round trip and the review view can show per-row deltas without parsing the diff client-side.

The diff for each row reuses the existing `DiffView` component (`plugins/conversations/conversation-view/code/plugins/file-pane/plugins/diff/web/components/diff-view.tsx`) — it already takes `{ conversationId, path }` and is fully self-contained, so rendering it inline per-row requires no refactor.

## Changes

### 1. Server — extend `edited-files` with line counts

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/shared/protocol.ts`

Extend the type:
```ts
export interface EditedFile {
  path: string;
  status: EditedFileStatus;        // unchanged: "modified" | "added" | "deleted" | "untracked"
  additions: number;               // new
  deletions: number;               // new
}
```

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts`

- Add `git diff --numstat main...HEAD` alongside the existing `--name-status` call, and merge the results by path. `numstat` reports `added\tdeleted\tpath` and emits `-\t-\t<path>` for binary files (treat as `0/0`).
- For untracked files (which `numstat` doesn't cover): count lines with a small streaming read, skipping binary (the existing diff endpoint already has a binary check we can extract or duplicate cheaply). Cap reads at the same 2 MB limit the diff endpoint uses; over-cap files report `additions: 0, deletions: 0`.
- For deleted files: `numstat` already reports `0\tN\tpath`; nothing extra needed.

The resource itself (`edited-files-resource.ts`) needs no change — it already invalidates on worktree changes; clients re-fetch and pick up the new fields.

### 2. Conversation-view — add `OpenMainView` command

**File:** `plugins/conversations/plugins/conversation-view/web/commands.ts`

Add a third pane command alongside `OpenMiddlePane` / `OpenRightPane`:
```ts
export const Conversation = {
  // ...existing
  OpenMainView: defineCommand<MainViewDescriptor | null, void>("conversation.open-main-view"),
};
```

`MainViewDescriptor` mirrors the existing pane descriptor shape (`{ id, title?, component }`).

**File:** `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`

- Add `mainView: MainViewDescriptor | null` state, wire `Conversation.OpenMainView.useHandler` to set it.
- In the render, if `mainView` is non-null: render `mainView.component` in place of the terminal, hide the middle pane, and hide the right pane (return `null` for both or skip rendering).
- If `mainView` is null: existing behavior is preserved exactly (terminal + optional middle/right).
- On `sessionId` change, also reset `mainView` to `null` (matches the existing reset of middle/right pane state).

This is intentionally minimal — no new slot, no plugin contract changes, just one more piece of pane state.

### 3. New `review` plugin

Location: `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/`

```
review/
├── package.json
└── web/
    ├── index.ts                       # contributes Code.ToolbarButton → ReviewButton
    └── components/
        ├── review-button.tsx          # toolbar button (count + delta, toggles main view)
        ├── review-view.tsx            # the main-view content (sticky header + file list)
        └── review-file-row.tsx        # one collapsible file row + inline DiffView when expanded
```

**`web/index.ts`** — registers the plugin and contributes:
```ts
Code.ToolbarButton({ component: ReviewButton });
```

**`review-button.tsx`**
- Uses `useEditedFiles(conversationId)` (already exists in `code/web/use-edited-files.ts`).
- Computes `total = files.length`, `additions = sum(f.additions)`, `deletions = sum(f.deletions)`.
- Renders something like: `[icon] 5 files  +123 −45`. Hidden / disabled state when `total === 0`.
- Reads current main-view state to know if review is already active (active styling).
- On click:
  - If not active → `Conversation.OpenMainView(reviewMainView(conversationId))`
  - If active → `Conversation.OpenMainView(null)`
- `reviewMainView(id)` is a small factory in this file (or `views.tsx`) that returns `{ id: "review", component: () => <ReviewView conversationId={id} /> }`.

**`review-view.tsx`**
- Top-level layout: sticky header (`position: sticky; top: 0`) + scrollable file list below.
- Sticky header contents: title (e.g. "Review · N files +A −D"), `Expand all` / `Collapse all` toggle, optionally a close (X) button that calls `OpenMainView(null)`.
- Owns an `expanded: Set<string>` state of file paths. "Expand all" sets it to all paths; "Collapse all" clears it. The toggle button label flips based on whether all are expanded.
- Renders one `<ReviewFileRow>` per file, sorted by status (new → modified → deleted) then path (or just by path — keep simple in v1).

**`review-file-row.tsx`**
- Props: `{ conversationId, file, expanded, onToggle }`.
- Header (always visible, clickable): status badge + file path + `+A −D` delta counts.
- Status badge color mapping: `added | untracked → "new"` (green), `modified` (yellow/blue), `deleted` (red).
- When `expanded`: renders `<DiffView conversationId={conversationId} path={file.path} />` directly below the header. `DiffView` already lazy-fetches per file, so the cost is paid only on expand. Renderers do not need to be cached/preloaded.

### 4. Plugin registration

Register the new plugin in the same place sibling plugins are registered (the parent `code` plugin's plugin registry / `plugins.ts`, mirroring `edited-files-button`). Wire its `package.json` into bun workspaces if not auto-discovered.

## Files touched

- `plugins/conversations/plugins/conversation-view/plugins/code/shared/protocol.ts` — extend `EditedFile`
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts` — add numstat merge + untracked line count
- `plugins/conversations/plugins/conversation-view/web/commands.ts` — add `Conversation.OpenMainView`
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` — add main-view state, render override, hide other panes
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/**` — new plugin (button + view + row)
- Parent `code` plugin's plugins registry — register `review`

## Reused (no changes)

- `useEditedFiles` hook — `plugins/conversations/plugins/conversation-view/plugins/code/web/use-edited-files.ts`
- `editedFilesResource` — invalidate-mode resource auto-refreshes on worktree change
- `DiffView` — already a self-contained `{ conversationId, path }` component; renders inline per row
- `Code.ToolbarButton` slot — same pattern as `edited-files-button`
- `defineCommand` plumbing — `OpenMainView` is just one more command

## Out of scope (v1)

- Rename / "moved" detection (would require `git diff --find-renames` and a new status; skipped per user).
- Per-file actions (approve / dismiss / comment) — not requested.
- Persisting review-mode state across reloads — confirmed in-memory only.
- Custom diff view for review (e.g. unified vs split toggle) — uses whatever `DiffView` renders today (split, with shiki).
- Global +/- displayed inside the review view sticky header is fine to derive from the same `useEditedFiles` totals; no new endpoint.

## Verification

End-to-end manual test after `./equin build`:

1. Open a conversation whose worktree has a mix of changes — at minimum: one new file, one modified file, one deleted file. (Easy way: drop a file, edit a tracked file, `rm` another.)
2. **Toolbar button**: confirm both `edited-files-button` and the new review button appear. Review button shows `N files +A −B`. Numbers match `git diff --numstat main...HEAD` plus the untracked file's line count.
3. **Activate review**: click the review button. Terminal pane is replaced by the review view. Right pane (if it was open) is hidden. Middle pane (if open) is hidden. Toolbar button shows active styling.
4. **Default state**: all rows collapsed. Each row shows correct status badge (`new` / `modified` / `deleted`) and matching `+A −B`.
5. **Expand a row**: diff renders inline (split view, shiki colors), matches what the existing diff plugin shows in the file pane for the same file.
6. **Expand all / Collapse all**: button toggles between expanded/collapsed for all files; label flips appropriately.
7. **Untracked & deleted files**: confirm both render diffs correctly inline (the existing diff endpoint already handles untracked via `git diff --no-index`).
8. **Exit review**: click the button again (or the close X). Terminal returns, middle/right pane state is restored — actually, since we wipe `mainView` only, middle/right pane state should still be in place; verify they reappear.
9. **Switch conversations**: navigate to a different conversation while review is active. New conversation opens with terminal (review state was per-conversation and reset on `sessionId` change). Returning to the first conversation: review state is reset (in-memory) — this matches the chosen scope.
10. **Empty edits**: open a conversation with zero edited files. Review button is disabled (or hidden). Clicking does nothing.
11. **Live updates**: with review mode open, modify a file in the worktree externally. The `edited-files` resource invalidates, the file list updates, deltas change. Already-expanded rows re-fetch their diff (or stay stale until re-expanded — acceptable for v1; flag if user wants live diff refresh).
