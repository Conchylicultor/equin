# Code plugin — Step 1: edited-files counter button

## Context

First slice of the Code meta plugin (full design:
`2026-04-14-plugins-code-meta-plugin.md`). Ship the smallest vertical stripe
end-to-end: a toolbar button in the conversation view that shows how many
files have been edited in the conversation's worktree. **No click action, no
list, no pane** — those come in later steps. Getting the plumbing right once
(meta plugin + one sub-plugin + server route + git detection) makes the next
steps trivial.

## Scope

**In:**
- `code` meta plugin scaffold (defines `Code.ToolbarButton` slot, server API).
- `toolbar-button` sub-plugin: icon + count, contributes to `Code.ToolbarButton`.
- Meta plugin's `Conversation.Toolbar` contribution renders the
  `Code.ToolbarButton` slot.
- Server endpoint `GET /api/conversations/:id/edited-files` returning count
  (file list payload is computed too but unused by UI for now — cheap and
  will be needed in step 2).

**Out (deferred):**
- onClick behavior — button is non-interactive (disabled or just static).
- `Code.FileList` / `Code.Pane` slots and their sub-plugins.
- `Conversation.MiddlePane` slot in conversation-view.
- Shiki, `react-resizable-panels`, shadcn `resizable` primitive.
- Shared zustand store (no state to hold yet — one TanStack Query hook suffices).

## Structure

```
plugins/conversations/plugins/conversation-view/plugins/code/
├── web/
│   ├── index.ts                     # Meta: defines Code.ToolbarButton slot; contributes wrapper to Conversation.Toolbar
│   ├── slots.ts                     # Code.ToolbarButton
│   ├── use-edited-files.ts          # TanStack Query hook
│   └── components/
│       └── toolbar-slot.tsx         # Renders Code.ToolbarButton.useContributions()
├── server/
│   └── index.ts                     # GET /edited-files route
├── shared/
│   └── protocol.ts                  # EditedFile + response zod schema
├── package.json
└── plugins/toolbar-button/
    └── web/
        ├── index.ts                 # Contributes to Code.ToolbarButton
        ├── package.json
        └── components/
            └── edited-files-button.tsx
```

## Button UI

- Icon: `FileDiff` from lucide-react (verify against existing usage).
- Label: numeric count; nothing while loading; nothing (or `0`) when no
  changes.
- Disabled visual state for now (no onClick). Tooltip: "Edited files (coming
  soon)".
- Uses the same button styling as sibling toolbar contributions
  (`vscode`/`status`/`open-app`) — copy their pattern.

## Edited-files detection (server)

In a new server sub-plugin under the Code meta:

1. Look up conversation by id → `worktreePath`.
2. Run in the worktree:
   - `git diff --name-status main...HEAD` (committed divergence from main)
   - `git status --porcelain` (unstaged + untracked)
3. Merge, dedupe by path, classify as `modified`/`added`/`deleted`/`untracked`.
4. Return `{ files: EditedFile[] }`. UI in step 1 only reads `files.length`.

Guardrails:
- If `main` doesn't exist or git fails, return `{ files: [] }` (button shows
  nothing rather than erroring).
- Use `Bun.spawn` (no new deps).

Route mounting: follow the pattern used by other conversation-view server
sub-plugins (pattern TBD while implementing — look at existing ones).

## Data flow

- `use-edited-files.ts`: `useQuery({ queryKey: ['conversation', id, 'edited-files'], refetchInterval: 10_000 })`.
- Button component calls the hook, renders `data?.files.length ?? null`.
- 10s polling matches the "toolbar always-live" cadence from the full plan.
  Upgrade to SSE later.

## Why a meta plugin now (vs inlining the button)

Could we just add a single flat plugin with the button and skip the
meta+sub-plugin split? Yes — but the split is cheap here (one extra
`index.ts`, one slot definition) and it locks in the composition pattern for
steps 2/3 where new sub-plugins (`file-list`, `file-pane`, and later
`diff-pane`) will plug into sibling slots. Doing it flat now and refactoring
later would churn more files.

## Files to create / modify

Create:
- `plugins/…/code/web/{index.ts,slots.ts,use-edited-files.ts,components/toolbar-slot.tsx}`
- `plugins/…/code/server/index.ts`
- `plugins/…/code/shared/protocol.ts`
- `plugins/…/code/package.json`
- `plugins/…/code/plugins/toolbar-button/web/{index.ts,components/edited-files-button.tsx}`
- `plugins/…/code/plugins/toolbar-button/web/package.json`

Modify:
- `web/src/plugins.ts` — register `codePlugin` and `codeToolbarButtonPlugin`.
- Conversation server plugin — mount the Code server sub-router.

No changes to `conversation-view.tsx` or its `slots.ts` in this step — the
button rides on the existing `Conversation.Toolbar` slot.

## Verification

1. `./equin build` succeeds.
2. `http://claude-1776140814.localhost:9000` — open a conversation whose
   worktree has real changes. Button shows matching count.
3. Compare to `git -C <worktree> diff --name-only main...HEAD | wc -l` plus
   `git status --porcelain | wc -l` (dedupe mentally).
4. Open a conversation with no changes → button shows nothing / `0`.
5. Edit a file in the worktree → within ~10s the count updates.
6. Clicking the button does nothing (expected).
