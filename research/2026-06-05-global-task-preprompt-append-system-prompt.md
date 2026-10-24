# Task preprompts — inject `--append-system-prompt` per task

## Context

We want to experiment with the Claude Code system prompt. The `claude` CLI supports
`--append-system-prompt <text>`, which *appends* to the default system prompt (unlike
`--system-prompt`, which replaces it and is already used for one-shot `--print` calls).

Goal: let the user maintain a small library of named **preprompts** (system-prompt
snippets) and pick **one** per task. When the task launches an agent, that preprompt is
appended to the Claude system prompt via `--append-system-prompt`.

Design mirrors the existing **conversation template config** (`prompt-templates` plugin):
a `config_v2` `listField` of `{ title, prompt }` items, edited in the Settings pane.
Selection is stored per-task via an entity-extension side-table, exactly like the
`auto-start` plugin stores its queued model. Injection happens at the single
`createConversation` → `runtime.create` chokepoint, so **every** launch path (manual
Launch button, auto-start, task-chain submit) gets it for free.

Decisions (confirmed with user): **single** preprompt per task; selectable **only** on
the task (draft card + task detail pane), not in the conversation prompt bar.

## Data model & flow

```
preprompts config (config_v2 listField {title, prompt}, stable UUID id per item)
        │  selected by id
        ▼
tasks_ext_preprompt  (entity-extension side-table: parent_id PK, preprompt_id)
        │  read at launch
        ▼
createConversation(taskId) ──resolve id→text──▶ runtime.create({ appendSystemPrompt })
        ▼
tmux: claude … --append-system-prompt "$(cat <tmpfile>)"
```

Storing the **id** (not the text) keeps the config the single source of truth; editing a
preprompt updates all tasks that reference it. A dangling id (deleted preprompt) resolves
to nothing → no flag appended (fail-soft, no crash).

## New plugins

### 1. `plugins/conversations/plugins/preprompts` — the library (config + resolve + picker)

Sibling to `model-provider`: a launch-time attribute registry. Mirrors `prompt-templates`.

- `shared/config.ts` — `prepromptsConfig = defineConfig({ fields: { preprompts: listField({ itemFields: { title: textField, prompt: multilineTextField } }) } })`. Copy `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/shared/config.ts` byte-for-byte, drop `pinnedCount`, rename `templates`→`preprompts`.
- `server/index.ts` — `ConfigV2.Register({ descriptor: prepromptsConfig })` + export `resolvePreprompt(id?: string): Promise<string | undefined>` that reads `getConfig(prepromptsConfig)` (server import `@plugins/config_v2/server`), finds the item by `id`, returns its `prompt` (trimmed, or undefined if empty/missing).
- `web/index.ts` — `ConfigV2.WebRegister({ descriptor: prepromptsConfig })` + export a reusable **`<PrepromptSelect value onChange />`** component (reads config via `useConfig(prepromptsConfig)`, renders a `Select` of `None` + each `{ id, title }`). Used by both the draft card and the task-detail section.

### 2. `plugins/tasks/plugins/task-preprompt` — per-task selection (mirror of `auto-start`)

- `server/internal/tables.ts` — `defineExtension(_tasks, "preprompt", { prepromptId: text("preprompt_id").notNull() })`. Copy `plugins/tasks/plugins/auto-start/server/internal/tables.ts` structure.
- `server/index.ts` — `getTaskPreprompt(taskId)`, `setTaskPreprompt(taskId, id | null)` (upsert / delete row), a `tasks-preprompt` push resource, and routes `PUT /api/tasks/:id/preprompt` + `DELETE /api/tasks/:id/preprompt` (or fold into the existing `PATCH /api/tasks/:id` — prefer dedicated routes, mirroring auto-start). Imports only `database`, `tasks-core._tasks`, `entity-extensions`, `endpoints` — **no `conversations`** (keeps the DAG: `conversations/server` → `task-preprompt/server`).
- `web/index.ts` — `TaskDetail.Section({ id: "preprompt", label: "Preprompt", component: TaskPrepromptSection })`. The section renders `<PrepromptSelect>` wired to a `useTaskPreprompt(taskId)` resource hook + `setTaskPreprompt` mutation. Imports `<PrepromptSelect>` from `@plugins/conversations/plugins/preprompts/web`.

## Edits to existing files

### Injection chokepoint

- **`plugins/conversations/server/internal/runtime.ts`** — add `appendSystemPrompt?: string` to the `ConversationRuntime.create` opts type (interface).
- **`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`** (`create`, ~line 596-641) — accept `appendSystemPrompt`; when present, write it to a temp file and push `` `--append-system-prompt "$(cat '${file}' && rm -f '${file}')"` `` onto `cmdParts`, **mirroring the existing `useTempFile` prompt pattern** (line 625-641). Temp file avoids tmux's ~16KB per-arg cap and all shell-quoting issues for multi-line prompts. Place the flag right after `claudeBase`/`--resume`, before the `--` prompt separator.
- **`plugins/conversations/plugins/runtime-api/server`** — add the same opts field to the stub interface impl (no-op) so the type matches.
- **`plugins/conversations/server/internal/lifecycle.ts`** (`createConversation`) — after `attemptId`/`taskId` are resolved, compute `effectiveTaskId` (= `opts.taskId` in the new-attempt path, or `attempt.taskId` when an existing `attemptId` was passed via `getAttempt`). Then:
  ```ts
  const appendSystemPrompt = effectiveTaskId
    ? await resolvePreprompt(await getTaskPreprompt(effectiveTaskId).then(r => r?.prepromptId))
    : undefined;
  ```
  Pass `appendSystemPrompt` into `runtime.create(...)` (the only call at line 163). Imports: `resolvePreprompt` from `@plugins/conversations/plugins/preprompts/server`, `getTaskPreprompt` from `@plugins/tasks/plugins/task-preprompt/server`. This single point covers manual launch, auto-start (`maybeLaunchTaskJob`), agents plugin, and chain — all funnel through `createConversation`. (Resume re-uses `--resume`; Claude keeps the original system prompt, so no re-injection needed — correct.)

### Draft-task form

- **`plugins/tasks/core/task-chain-types.ts`** — add `prepromptId: z.string().optional()` to `TaskChainCardSchema`.
- **`plugins/tasks/plugins/task-draft-form/web/components/task-draft-form.tsx`** — add `prepromptId?: string` to `CardDraft`.
- **`.../task-draft-card.tsx`** — render `<PrepromptSelect>` next to `ModelChip` (bottom of the card), bound to the card's `prepromptId`.
- **`.../internal/submit.ts`** — thread `prepromptId` into each `TaskChainCard`.
- **`plugins/tasks/server/internal/handle-create-chain.ts`** — after `createTask(...)` (inside the loop, ~line 96-108), if `card.prepromptId` set, `await setTaskPreprompt(newTask.id, card.prepromptId)`. Import from `@plugins/tasks/plugins/task-preprompt/server`. (`tasks/server` already imports `auto-start` via `armTaskAutoStart`, so this edge is the same shape.)

## Plugin boundary / DAG check

- `task-draft-form/web` → `preprompts/web` (PrepromptSelect): new edge, no cycle.
- `task-preprompt/web` → `preprompts/web`: new edge, no cycle.
- `conversations/server` → `preprompts/server` + `task-preprompt/server`: no cycle (`task-preprompt/server` and `preprompts/server` do not import `conversations`). Matches the existing `conversations/server` → `auto-start/server` precedent.
- `tasks/server` → `task-preprompt/server`: same shape as existing `tasks/server` → `auto-start`.
- Each new plugin gets its own runtime barrels (`web/index.ts`, `server/index.ts`, `shared/`). No authored `id:`. No cross-plugin re-exports.

## Verification (end-to-end)

1. `./equin build` (regenerates the `tasks_ext_preprompt` migration, builds, restarts, registers gateway).
2. `./equin check` — confirm `migrations-in-sync`, `eslint`, plugin-boundaries, and `plugins-doc-in-sync` pass.
3. In the app (`http://<worktree>.localhost:9000`): Settings → `conversations/preprompts` config → add a preprompt e.g. `{ title: "Terse", prompt: "Always answer in one sentence." }`.
4. Draft a task, pick "Terse" in the new dropdown, launch it. Or open an existing task's detail pane → Preprompt section → pick "Terse" → Launch.
5. Confirm the flag actually reaches Claude — inspect the live tmux command:
   ```bash
   tmux list-panes -a -F '#{pane_start_command}' | grep append-system-prompt
   ```
   and verify the agent's behavior reflects the appended instruction (ask it a question; it should obey the preprompt). The `e2e/screenshot.mjs` helper can drive the dropdown click + launch.
6. DB check: `mcp__singularity__query_db` `SELECT * FROM tasks_ext_preprompt;` shows the row; clearing the dropdown deletes it.

## Out of scope (noted)

- Per-conversation / prompt-bar selection and forks reusing an `attemptId` without a `taskId` (e.g. `launch-prompts`, fork buttons) — no preprompt injected. Can be added later by threading `appendSystemPrompt` from those callers.
- Global default preprompt.
