# Typed task author + "Filed from"

## Context

The user wants to filter the task lists by **who created a task** (Human / Agent / System) and by
**which surface it was filed from**. Today both are folded into `tasks.author`, a free string that
is neither a list field nor consistent:

- Values on main: `improve-plugin` 3064, `conv-…` 2858, `user` 683, `task-triage` 526,
  `singularity` 378, NULL 146, `reports-plugin`, `crashes-plugin`, `agents-plugin`,
  `automation:<id>`, `deps.*`, `sonata-transcription`, … — each writer invents its own string.
- `handle-create.ts:58` defaults a missing author to `"user"`; `CreateTaskBodySchema.author` is a
  free `z.string()`.
- Readers sniff the string: `AuthorDisplay` treats anything not `"user"` as a conversation id
  (so Wish tasks show the raw text `improve-plugin`); `watch-sources.ts:33` does
  `conversationIdKind.is(author)`.
- `author` is only *carried* by the task collections (`resources.ts:68,97`), never a field, so the
  DataView cannot filter on it.
- The "surface" it seems to encode is accidental: `improve-plugin` = "draft form targeted a
  category" (Wish, Home, Deploy, Prototypes alike); `user` = half a dozen unrelated surfaces.

Outcome: two orthogonal, typed facts, both first-class DataView fields on every task list.

## Design

### The two facts

```ts
// tasks-core/core
export type TaskAuthor =
  | { kind: "human" }                                        // a person's action decided it
  | { kind: "agent"; conversationId: ConversationId }        // an agent filed it (add_task, …)
  | { kind: "system" };                                      // code filed it on its own
```

- **Author** = who *decided* the task should exist. A task code files because the person clicked
  something (Investigate on a report, Launch on a saved agent, Sonata transcribe) is **human**
  (user decision, 2026-11-13). **System** is only what code files unprompted: triage,
  automations (incl. deps upgrades, report-investigation automation), the old crash tasks.
- **Filed from** = the `PluginId` of the surface that filed it (`wish`, `apps.home`,
  `tasks.task-list`, `tasks` for `add_task`, `tasks.task-triage`, `tasks.automations`,
  `reports.engine`, …). Reuses the existing plugin identity — no new registry. For a system task
  it *is* the system's identity, so the system arm needs no payload.

### Storage (`tasks-core/core/internal/fields.ts`, `server/internal/tables.ts`)

Replace `author` with:

| column | field | notes |
|---|---|---|
| `author_kind` | `enumTextField(["human","agent","system"], { label: "Created by", options })` | NOT NULL |
| `author_conversation_id` | `nullable(textField({ label: "Author" }))` | the agent's conversation |
| `filed_from` | `nullable(textField({ label: "Filed from" }))` | NULL only for rows filed before tracking |

- CHECK `tasks_author_agent_has_conversation`:
  `(author_kind = 'agent') = (author_conversation_id IS NOT NULL)` — same pattern as
  `tasks_root_has_mandate` (`tables.ts` `indexes`).
- `updatedAt.touchedBy`: all three `false`.
- `tasks_v` derives from `getTableColumns(_tasks)` — no view edit.
- Model: `conversations.kind` (`fields.ts:156`) is the precedent for a user/agent/system enum
  with options.

### Write API — make the wrong thing unspellable

- `createTask` / `createTaskOn` (`tasks-core/server/internal/mutations/tasks.ts`): input takes
  **required** `author: TaskAuthor` and `filedFrom: PluginId`. No default. Maps to the columns in
  one place. `taskCreated` payload (`tables-events.ts:50`) carries `author: TaskAuthor` +
  `filedFrom`.
- `filedFrom` is asserted at the boundary in `createTaskOn` to name a plugin of the running
  composition (server ∪ `composition.webPlugins`) — a typo is a loud 500, not a silent bad label.
- HTTP endpoints (`tasks/core/endpoints.ts`): drop `author` from `CreateTaskBodySchema`; the
  server stamps `{ kind: "human" }` (these endpoints are the UI's). Add **required**
  `filedFrom` to the create, chain, insert-between and launch-task bodies — the UI surface states
  where it is.
- Web: `TaskDraftPopover` / the chain form get a required `filedFrom` prop, so every surface that
  mounts it (Wish, Home cards, Deploy, Prototypes, conversation child-task button, menu-bar task,
  …) must name itself (tsc finds them all).
- Conversations fresh launch (`conversations/server/internal/lifecycle.ts:486`): stop copying
  `spawnedBy` into the task author. The `{ mandate }` target gains required
  `author` + `filedFrom`; `conversations/machine/internal/handle-create.ts` passes
  `{ kind: "human" }`, `"conversations"`.

Writer mapping (every `createTask` call site):

| call site | author | filedFrom |
|---|---|---|
| `tasks/server/internal/handle-create.ts` | human | body (`active-data.task`, `tasks.task-list`) |
| `tasks/server/internal/handle-create-chain.ts` | human | body (each draft surface) |
| `tasks/server/internal/handle-insert-between.ts` | human | body |
| `tasks/machine/internal/handle-launch-task.ts` | human | body |
| `tasks/machine/internal/add-task-filing.ts` (MCP `add_task`) | agent(conversationId) | `tasks` |
| `hints/plugins/ask/server/internal/tools.ts` (`file_task`) | agent | `hints.ask` |
| `plugin-meta/plugins/plugin-health/server/internal/mcp-tools.ts` | agent | `plugin-meta.plugin-health` |
| `page/…/todo/plugins/task-link/server/internal/mutations.ts` | human | `page.annotations.todo.task-link` |
| `page/plugins/prompt/plugins/link/server/internal/mutations.ts` | human | `page.prompt.link` |
| `reports/plugins/engine/server/internal/investigate.ts` (+ `investigation-sink.ts`, `tasks/plugins/reports-investigation/…/register.ts`) | human | `reports.engine` |
| `conversations/plugins/agents/machine/internal/handle-launch.ts` | human | `conversations.agents` |
| `apps/plugins/sonata/plugins/transcription/server/internal/routes.ts` | human | `apps.sonata.transcription` |
| `tasks/plugins/task-triage/server/internal/dispatch.ts` | system | `tasks.task-triage` |
| `tasks/plugins/automations/server/internal/origin.ts` | system | `tasks.automations` |
| `conversations/server/internal/lifecycle.ts` fresh launch | from caller | from caller |
| `debug/plugins/read-set/server/internal/narrowing-fixture.ts` | system | `debug.read-set` |
| website seeds (`demos/workspace/bin/seed.ts`, `promo-film/seed`) | human | their plugin |

(The investigation sink's `author: string` becomes `TaskAuthor` + `filedFrom`.)

### Readers

- **DataView fields**: in `tasks-core/core/resources.ts` move `author` out of
  `TASK_ROW_CARRY` / `TASK_TREE_CARRY`; add `authorKind`, `authorConversationId`, `filedFrom` to
  `TASK_ROW_PICK` (reaches `taskRows`, `taskClusterRows`, `taskWindow`). A removed field ⇒ rename
  the keys (`tasks.v2` → `tasks.v3`, and the tree / cluster keys likewise), per the comment there.
  Result: **Created by**, **Author**, **Filed from** filter / group / column in every task list.
  `Author` renders the conversation id through its id-kind presenter (chip → conversation);
  `Filed from` through the plugin id presenter if one exists, else text.
- **Task header** `task-header/web/components/author-display.tsx`: switch on kind — "You", the
  agent's task (via conversation, as today), or the `filedFrom` plugin for system.
- **Watch** `tasks/machine/internal/watch-sources.ts`: `author.kind === "agent"` →
  `actorConversationId`.
- **Deps legacy reader** `infra/deps/plugins/updates/server/internal/detect-job.ts`
  `legacyUpgradeTaskIds`: `filed_from = 'infra.deps.updates'` instead of `author LIKE 'deps.%'`.
- `TaskResponseSchema` (`endpoints.ts:127`): `author` → the three fields.
- Narrowing fixture read-back: compare `filedFrom`.

### Migration (phased, one push)

`./equin build --custom-migration --migration-name task_author_kind` → hand-write idempotent DML;
then `./equin build --migration-name task_author_kind` generates expand (add nullable columns) /
contract (SET NOT NULL, CHECK, DROP `author`) and claims the data step. Backfill:

```sql
-- agent
UPDATE tasks SET author_kind='agent', author_conversation_id=author
 WHERE author_kind IS NULL AND (author LIKE 'conv-%' OR author LIKE 'claude-%');
-- human: UI + click-filed + old fresh launches ('singularity' = the main namespace, via spawnedBy)
UPDATE tasks SET author_kind='human'
 WHERE author_kind IS NULL AND (author IS NULL OR author IN
   ('user','improve-plugin','singularity','reports-plugin','agents-plugin','sonata-transcription'));
-- system: everything else (task-triage, automation:*, deps.*, crashes-plugin, …)
UPDATE tasks SET author_kind='system' WHERE author_kind IS NULL;
-- filed_from where the old string says it for sure; NULL = filed before tracking
UPDATE tasks SET filed_from = CASE
   WHEN author='task-triage' THEN 'tasks.task-triage'
   WHEN author LIKE 'automation:%' THEN 'tasks.automations'
   WHEN author='reports-plugin' THEN 'reports.engine'
   WHEN author='agents-plugin' THEN 'conversations.agents'
   WHEN author='sonata-transcription' THEN 'apps.sonata.transcription'
   WHEN author LIKE 'deps.%' THEN 'infra.deps.updates' END
 WHERE filed_from IS NULL AND author IS NOT NULL;
```

(`improve-plugin` rows stay NULL for filed-from: the category already says which surface.)

### Out of scope

- `conversations.spawned_by` is the same smell (free string mixing namespaces, causes, plugin
  names). Only its coupling into task author is cut here; typing it is a follow-up task.

## Verification

1. `./equin build` (generates + applies the phased migration), `./equin check`.
2. `query_db`: `select author_kind, filed_from, count(*) from tasks group by 1,2` — no NULL
   kind, CHECK holds; spot-check mapping vs the old distribution.
3. `./equin test plugins/tasks/plugins/tasks-core` (+ `all-parity.test.ts`, add-task-filing,
   watch tests); add a `createTaskOn` test for the CHECK and the unknown-`filedFrom` assert.
4. Browser (`browser_*` on own build): task list → filter **Created by = Agent / Human /
   System**, group by **Filed from**; file a task via Wish and via the task list and confirm
   `human` + the right `filed_from`; agent `add_task` shows Agent + author chip; task header
   shows "You" / the agent's task / the system plugin.
