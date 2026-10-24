# Unify conversation plugins under `plugins/conversations/`

## Context

Today, conversation-related code is split across two sibling plugins that share the same domain:

- `plugins/conversation/` — the single-conversation pane (`Shell.Route /c/:id`) plus nested toolbar contributors (`open-app`, `vscode`).
- `plugins/conversations/` — the sidebar list, plus the server code (tmux + db-fork) that powers it.

They reference each other constantly (`@plugins/conversation/web/views` from the list, `@plugins/conversations/shared/types` from the pane) and will share a DB schema soon. Keeping them as siblings blurs ownership: where does `server/`, `shared/types`, or a future `schema.ts` belong?

Unifying them into one `plugins/conversations/` domain with inner view plugins makes the relationships explicit and gives the upcoming DB schema a natural home — without introducing a generic `plugins/db/`.

This plan covers the **refactor only**. DB schema lands in a follow-up session.

## Target structure

```
plugins/conversations/
  package.json                  # kept; absorbs @singularity/plugin-conversation
  server/                       # shared server code
    index.ts
    internal/
      tmux.ts
      db-fork.ts
  shared/
    types.ts                    # Conversation type (unchanged)
  plugins/
    conversation-view/          # was plugins/conversation
      web/
        index.ts
        slots.ts
        views.tsx
        components/
      plugins/                  # nested toolbar contributors
        open-app/web/index.ts
        vscode/web/index.ts
    conversations-view/         # was plugins/conversations (sidebar list)
      web/
        index.ts
        components/
```

Inner plugins (`conversation-view`, `conversations-view`, and the toolbar sub-plugins) **do not get their own `package.json`** — matching the existing convention for `plugins/conversation/plugins/open-app/`. Root `package.json` workspaces glob is `plugins/*`, so only `plugins/conversations/` is a workspace.

## Import path changes

TS path alias `@plugins/*` already maps to `plugins/*`, so all rewrites are pure path edits — no `tsconfig` change.

| Old | New |
| --- | --- |
| `@plugins/conversation/web` | `@plugins/conversations/plugins/conversation-view/web` |
| `@plugins/conversation/web/views` | `@plugins/conversations/plugins/conversation-view/web/views` |
| `@plugins/conversation/web/slots` | `@plugins/conversations/plugins/conversation-view/web/slots` |
| `@plugins/conversation/plugins/open-app/web` | `@plugins/conversations/plugins/conversation-view/plugins/open-app/web` |
| `@plugins/conversation/plugins/vscode/web` | `@plugins/conversations/plugins/conversation-view/plugins/vscode/web` |
| `@plugins/conversations/web` | `@plugins/conversations/plugins/conversations-view/web` |
| `@plugins/conversations/server` | *unchanged* (now the shared server) |
| `@plugins/conversations/shared/types` | *unchanged* |

### Files that import these paths

From grep (excluding `research/`):

- `web/src/plugins.ts` — registry (4 rewrites).
- `server/src/plugins.ts` — registry (no rewrite; server path unchanged).
- `plugins/welcome/web/components/welcome-view.tsx` — 1 rewrite (`conversationPane` from `conversation-view/web/views`).
- `plugins/conversation/plugins/vscode/web/index.ts` — moved file; 1 self-rewrite.
- `plugins/conversation/plugins/open-app/web/index.ts` — moved file; 1 self-rewrite.
- `plugins/conversations/web/components/conversation-list.tsx` — moved file; 1 rewrite.

## Steps

1. `git mv plugins/conversation/web plugins/conversations/plugins/conversation-view/web`
2. `git mv plugins/conversation/plugins plugins/conversations/plugins/conversation-view/plugins`
3. `git mv plugins/conversations/web plugins/conversations/plugins/conversations-view/web`
4. Delete `plugins/conversation/package.json` and the now-empty `plugins/conversation/` directory.
5. Update imports per table above (grep-driven; 6 files).
6. Update `plugins/CLAUDE.md` outline: collapse `conversation` and `conversations` entries into one `conversations` section with the new nesting.
7. `bun install` (workspace layout changed: one workspace removed).
8. `./equin build` — confirms typecheck + frontend build + server start.

## Verification

1. `./equin build` completes cleanly.
2. `http://<worktree>.localhost:9000` loads; sidebar shows "Conversations".
3. Click into a conversation → pane opens at `/c/:id`, toolbar shows "Open" and "VSCode" buttons (both sub-plugins still registered).
4. "Open" button opens `http://<id>.localhost:9000/`; "VSCode" opens the session cwd.
5. Create a new conversation from the UI → tmux session starts, DB is forked, row appears in list (unchanged behavior, just validating server-side code still works).

## Not in scope

- Any DB schema, `conversations` table, status, or push tracking — next session.
- Renaming the plugin IDs (`conversation-open-app`, etc.) — kept as-is to avoid churn.
