# Migrate `useData()` → `useInput()` + self-fetch

## Context

PR 1 established the chain-first architecture: removed `after:`, added `input`/`useInput()` on `PaneSlot`, added `defaultAncestors`, and made `history.state` the runtime source of truth. `provides`/`provide`/`useData()` still works by chain position.

This plan covers PR 2: migrating all `useData()` consumers so each pane fetches its own data rather than depending on an ancestor being present in the chain.

## Provider inventory

| Provider pane | has `provide:` (chain-level) | External `useData()` callers | Migration scope |
|---|---|---|---|
| `conversationPane` | Yes | ~31 files | Large — all tiers |
| `taskDetailPane` | No (internal only) | 0 (`useDataMaybe`: 3 files) | Small |
| `agentDetailPane` | No (internal only) | 0 | None |
| `serverDetailPane` | No (internal only) | 1 (internal) | Trivial |

**The entire migration centers on `conversationPane`.** The other three providers render their Provider inside their own component body (no `provide:` field), so they never create chain-level context visible to sibling columns.

## Consumer tiers for `conversationPane`

### Tier 1 — PaneChrome Actions (inside conversation column)

Contributed to `conversationPane.Actions`. Always rendered inside the conversation column. Can switch from `useData()` to `useParams()` + self-fetch via existing `useConversation(convId)` / `useConversationById(convId)`.

| File | Reads |
|---|---|
| `conversation-view/plugins/status/web/components/status-badge.tsx` | `conversation.status` |
| `conversation-view/plugins/allow-monitor/web/components/allow-monitor-chip.tsx` | `conversation.id` |
| `conversation-view/plugins/model/web/components/model-badge.tsx` | `conversation.model` |
| `conversation-category/web/components/category-chip-toolbar.tsx` | `conversation.id`, `conversation.kind` |
| `conversation-progress/web/components/progress-bar-toolbar.tsx` | `conversation.id`, `conversation.kind` |

### Tier 2 — Toolbar buttons (open sibling panes)

Contributed to `Conversation.ActionBar`. Call `useData()` to get `conversation.id` for `useToggle()`. Switch to `useParams()` and pass `convId` as `input`.

| File | Reads | Opens |
|---|---|---|
| `terminal-pane/web/components/terminal-button.tsx` | `conversation.id` | `convTerminalPane` |
| `tasks-panel/web/components/tasks-button.tsx` | `conversation.id`, `conversation.taskId` | `convTasksPane` |
| `commits-graph/web/components/commits-chip.tsx` | `conversation.id`, `conversation.attemptId` | `convCommitsGraphPane` |
| `code/plugins/review/web/components/review-button.tsx` | `conversation.id`, `conversation.attemptId` | `convReviewPane` |
| `code/plugins/docs-button/web/components/docs-button.tsx` | `conversation.id`, `conversation.attemptId` | `convDocsPane` |
| `open-app/web/components/open-app-button.tsx` | `conversation.attemptId` | — |
| `vscode/web/components/vscode-button.tsx` | `conversation.worktreePath` | — |
| `code-explorer/web/components/conv-tree-button.tsx` | `conversation.id` | `convFileTreePane` |
| `attempt-view/web/components/attempt-switch-button.tsx` | `conversation.attemptId` | `attemptPane` |
| `summary/web/components/summarize-button.tsx` | `conversation.id` | `convSummaryPane` |
| `fork-session/web/components/fork-session-action.tsx` | `conversation.id`, `conversation.claudeSessionId` | — |

### Tier 3 — Sibling pane bodies (opened to the right of conversation)

These panes appear as sibling columns and read `conversationPane.useData()`. They need `input: type<{ convId: string }>()` and self-fetch.

| Pane | File | Reads |
|---|---|---|
| `convTerminalPane` | `terminal-pane/web/components/terminal-pane-body.tsx` | `conversation.id`, `conversation.status` |
| `convTasksPane` | `tasks-panel/web/components/tasks-pane.tsx` | `conversation.taskId` |
| `convCommitsGraphPane` | `commits-graph/web/components/commits-graph-body.tsx` | `conversation.attemptId`, `conversation.id` |
| `convCommitDiffPane` | `commits-graph/web/panes.tsx` (`ConvCommitDiffBody`) | `conversation.attemptId` |
| `convReviewPane` | `code/plugins/review/web/components/review-view.tsx` | `conversation.id`, `conversation.attemptId` |
| `convDocsPane` | `code/plugins/docs-button/web/components/docs-pane.tsx` | `conversation.id`, `conversation.attemptId` |
| `convSummaryPane` | `summary/web/components/summary-pane.tsx` | `conversation.id` |
| `convFileTreePane` | `code-explorer/web/components/conv-file-tree-body.tsx` | `conversation.attemptId` |
| `taskSidePane` | `side-task/web/components/side-task-body.tsx` | `conversation.id` |
| `agentReportPane` | `tool-call/plugins/agent/web/components/agent-report-pane.tsx` | `conversation.id` |

### Tier 4 — Deep JSONL viewer components (inside conversation tree)

Rendered inside the conversation pane's own React tree (JSONL viewer rows). Can use `conversationPane.useParams()` directly since they're always inside the conversation column.

| File | Reads |
|---|---|
| `assistant-text/web/components/assistant-text-row.tsx` | `conversation.id` |
| `message-toc/web/components/message-toc.tsx` | `conversation.id` |
| `tool-call/web/components/tool-file-path.tsx` | `conversation.attemptId` |
| `user-text/web/components/user-text-row.tsx` | `conversation.attemptId` |
| `tool-call/plugins/read/web/components/read-tool-view.tsx` | `conversation.attemptId` |
| `tool-call/plugins/agent/web/components/agent-report-pane.tsx` | `conversation.id` |
| `tool-call/plugins/add-task/web/components/add-task-tool-view.tsx` | `conversation.id` |
| `new-child-task/web/components/new-child-task-action.tsx` | `conversation.taskId` (deprecated) |

### Tier 5 — `useDataMaybe()` callers (context probes)

Optional access — work in multiple contexts. Switch to `useChainEntry()` probes.

| File | Reads | Fallback |
|---|---|---|
| `markdown-extensions/web/internal/img-enhancer.tsx` | `conversation.attemptId` | `taskDetailPane.useDataMaybe()` |
| `markdown-extensions/web/internal/file-links-enhancer.tsx` | `conversation.attemptId` | `taskDetailPane.useDataMaybe()` |
| `markdown-extensions/web/internal/code-enhancer.tsx` | `conversation.attemptId` | `taskDetailPane.useDataMaybe()` |
| `active-data/plugins/task-link/web/components/task-link-chip.tsx` | `conversation.id` | opens full pane |
| `active-data/plugins/plugin-link/web/components/plugin-link-chip.tsx` | `conversation.id` | opens full pane |

## Design decisions

### Extend `useToggle` to accept `input`

Current API: `useToggle(params, opts?)`. Toggle buttons pass `convId` via params from `useData()`. After migration, they need to pass it as `input`.

**Solution**: add `input?: Record<string, string>` to `PaneToggleOpts`. When the pane is opened via toggle, the input is stored in the slot. `chainsEqual` already compares input fields.

### Self-fetch hook pattern

Most consumers just need `conversation` from a `convId`. Standardize on:

```ts
const { convId } = myPane.useInput();
const conversation = useConversation(convId); // already exists, live-state backed
```

`useConversation(convId)` is already the standard hook (from `@plugins/conversations/web`), backed by `conversationsResource` (WebSocket push). No new hooks needed.

### `ActiveRelateSync` side-effect

`ConversationPaneProvide` renders `<ActiveRelateSync />` which installs an ambient task-relate context. After removing `provide:`, move `ActiveRelateSync` into `ConversationView` (the pane's own component) where `convId` is available via `useParams()`.

### `taskDetailPane.useDataMaybe()` in markdown-extensions

The 3 markdown enhancers probe both `conversationPane` and `taskDetailPane` to determine worktree context. After migration:
- `conversationPane.useChainEntry()?.params.convId` → self-fetch → `conversation.attemptId`
- `taskDetailPane.useChainEntry() !== null` → use `"main"`

## Migration phases

### Phase 1: Infrastructure — extend `useToggle` with `input`

**File**: `plugins/primitives/plugins/pane/web/pane.ts`

Add `input` to `PaneToggleOpts`. When toggling open, pass input to `createSlot`.

### Phase 2: Sibling pane bodies (Tier 3) — add `input`, switch to self-fetch

For each sibling pane, add `input: type<{ convId: string }>()` to the pane definition and switch the body component from `conversationPane.useData()` to `useInput()` + `useConversation(convId)`.

**Order** (simplest first):
1. `convSummaryPane` — reads only `conversation.id`
2. `convFileTreePane` — reads only `conversation.attemptId`
3. `convTerminalPane` — reads `conversation.id`, `conversation.status`
4. `taskSidePane` — reads `conversation.id`
5. `agentReportPane` — reads `conversation.id`
6. `convCommitsGraphPane` — reads `conversation.id`, `conversation.attemptId`
7. `convCommitDiffPane` — reads `conversation.attemptId`
8. `convTasksPane` — reads `conversation.taskId`
9. `convReviewPane` / `convDocsPane` — read `conversation.id`, `conversation.attemptId`

### Phase 3: Toggle callers (Tier 2) — switch from `useData()` to `useParams()`, pass `input`

Each toolbar button switches from:
```ts
const { conversation } = conversationPane.useData();
const { toggle } = convTerminalPane.useToggle({ convId: conversation.id });
```
To:
```ts
const { convId } = conversationPane.useParams();
const { toggle } = convTerminalPane.useToggle({}, { input: { convId } });
```

### Phase 4: PaneChrome Actions (Tier 1) — switch to `useParams()` + self-fetch

Each action badge/chip switches from `conversationPane.useData()` to:
```ts
const { convId } = conversationPane.useParams();
const conversation = useConversation(convId);
```

### Phase 5: JSONL viewer components (Tier 4) — switch to `useParams()`

Components inside the conversation tree switch from `conversationPane.useData()` to `conversationPane.useParams()` + self-fetch.

### Phase 6: `useDataMaybe()` callers (Tier 5) — switch to `useChainEntry()`

- `conversationPane.useDataMaybe()` → `conversationPane.useChainEntry()?.params.convId` + conditional self-fetch
- `taskDetailPane.useDataMaybe()` → `taskDetailPane.useChainEntry() !== null`

### Phase 7: Remove `provides`/`provide` from `conversationPane`

Once all consumers are migrated:
1. Remove `provides:` and `provide:` from `conversationPane` definition
2. Delete `ConversationPaneProvide` and `ConversationProvide` components
3. Move `ActiveRelateSync` into `ConversationView`
4. Remove `conversationPane.Provider` usage

For `taskDetailPane`, `agentDetailPane`, `serverDetailPane`: remove `provides:` from definitions (they have no `provide:`, no external consumers).

## Verification

1. `./equin build` — all TypeScript / ESLint checks pass
2. Test conversation view: open a conversation, verify JSONL renders, toolbar buttons work
3. Test sibling panes: open terminal, tasks panel, review, docs, commits, summary — verify they load data
4. Test closing the conversation pane column (promote a sibling) — verify sibling panes still work with their own data
5. Test back/forward navigation — verify input persists across history entries
6. Test deep links — paste a conversation URL, verify the page loads correctly
7. Grep for remaining `useData` / `useDataMaybe` calls — should be zero for `conversationPane`
