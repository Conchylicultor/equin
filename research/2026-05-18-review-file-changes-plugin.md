# Plan: `file-changes` sub-plugin for PluginChanges

## Context

The review pane's `PluginChanges.Section` slot already supports extensible sections per-plugin card (e.g. `api-changes` shows API diffs). However:
1. There's no section showing the actual **file-level diffs** for each plugin — the only way to see code changes is the full conversation code-review.
2. The file stats badge (`5f +30 -10`) is **hardcoded** in `plugin-change-card.tsx` rather than contributed via the slot system.

This plan adds a `file-changes` sub-plugin that contributes both the section (collapsible file list with inline diffs) and a `summary` component (the stats badge), then removes the hardcoded version.

## Implementation

### 1. Protocol — add `files` to `PluginChangeDiff`

**File:** `plugins/review/plugins/plugin-changes/core/protocol.ts`

```ts
export interface PluginChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  from?: string;
}

// Add to PluginChangeDiff:
files: PluginChangedFile[];
```

Also add `PluginChangedFile` to the core barrel re-exports.

### 2. Server — populate `files`

**File:** `plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts`

In the loop building each `PluginChangeDiff` (line ~121), add:

```ts
files: files.map((f) => ({
  path: f.path,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  ...(f.from ? { from: f.from } : {}),
})),
```

The `files` variable (of type `EditedFile[]`) is already in scope — no new query needed.

### 3. Card header — remove hardcoded stats

**File:** `plugins/review/plugins/plugin-changes/web/components/plugin-change-card.tsx`

Delete lines 42–52 (the `<span>` rendering `{fileCount}f +X -Y`). The `file-changes` plugin contributes a `summary` component that renders the same badge.

### 4. New sub-plugin: `plugins/review/plugins/plugin-changes/plugins/file-changes/`

Structure:
```
file-changes/
  package.json
  CLAUDE.md
  web/
    index.ts
    components/
      file-changes-section.tsx
      file-changes-summary.tsx
```

**`web/index.ts`** — contributes `PluginChangesSlots.Section` with id `"file-changes"`, component `FileChangesSection`, summary `FileChangesSummary`, hasContent checks `plugin.files.length > 0`.

**`file-changes-summary.tsx`** — verbatim extraction of the deleted stats badge: `{fileCount}f +{additions} -{deletions}`. Same classes, same conditional rendering.

**`file-changes-section.tsx`** — collapsible file list:
- Uses `useConversationById(conversationId)` → `conversation.attemptId` as the `worktree` prop
- Renders each `PluginChangedFile` as a `FileRow`: status badge + dir/basename path + +/- counts
- On expand, renders `<DiffOrImageView worktree={attemptId} path={file.path} base="main" from={file.from} />`
- Status badge colors and labels mirrored from `review-file-row.tsx` but keyed on `string` (not `EditedFileStatus` enum)
- No warning-level system (that's review-specific config)

### Key reuse

| What | From | How |
|------|------|-----|
| `DiffOrImageView` | `@plugins/.../diff/web` | Direct import, prop-driven |
| `CollapsibleChevron` | `@plugins/primitives/plugins/collapsible/web` | Chevron indicator |
| `CopyButton` | `@plugins/primitives/plugins/copy-to-clipboard/web` | Copy file path |
| `useConversationById` | `@plugins/conversations/web` | Resolve attemptId |
| Status badge styling | Copied from `review-file-row.tsx` | String-keyed maps |

### Critical files

- `plugins/review/plugins/plugin-changes/core/protocol.ts` — add type + field
- `plugins/review/plugins/plugin-changes/core/index.ts` — export new type
- `plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts` — populate files
- `plugins/review/plugins/plugin-changes/web/components/plugin-change-card.tsx` — remove hardcoded stats
- `plugins/review/plugins/plugin-changes/plugins/file-changes/` — new plugin (4 files)

## Verification

1. `./equin build` — ensures TypeScript compiles and plugin is discovered
2. Open the app at `http://<worktree>.localhost:9000`
3. Open a conversation with file changes → Review pane → Plugin Changes section
4. Verify: card headers show the stats badge (from summary contribution, not hardcoded)
5. Verify: expanding a plugin card shows "File Changes" section with collapsible file rows
6. Verify: expanding a file row shows the side-by-side diff via DiffOrImageView
