# Conversation title mode: conversation / task / short

## Context

Prototype `proto-1789643584-ldt6` has a `mist-titles: full | short` option. In short mode, each row shows a title of at most three words, and hovering shows the full title. The mock hand-writes a `short` string per row.

In the app, every place that names a conversation shows **the conversation's own title**, through `conversationTitle(conv)` in `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx:98`. That title does not stay in sync with the task title:
- it is copied from the task title only while it is still empty (`updateConversationsTitleForTask`);
- the poller overwrites it with the Claude Code pane title (`plugins/conversations/server/internal/poller.ts:235-268`);
- renaming a task never reaches it;
- each conversation of a task keeps its own title.

Goal: add one global setting, **Conversation list title**, with three values. It is a config setting only (Settings → Config), with **no control in the list itself**. It changes **only the rows of the conversations list** on `/agents` (the Queue and History sources of the sidebar DataView). Chips, the task's attempts section, the attempt pane and every other place that names a conversation keep showing the conversation title.

| Mode | Label | Hover |
|---|---|---|
| `conversation` (default, today) | conversation title | conversation title |
| `task` | task's full title | task's full title |
| `short` | task's ≤3-word short title | task's full title |

## Design

### 1. Task title on the conversation row (tasks-core)

- Add `taskTitle: _tasks.title` to the `conversations_v` derived view in `plugins/tasks/plugins/tasks-core/server/internal/views.ts:401`. That means one more inner join, next to the existing `attempts` join. It is a derived view, so it is rebuilt on boot and needs no migration.
- Add `taskTitle: z.string()` to `ConversationSchema` in `tasks-core/core/internal/schema.ts:108`.
- Both list sources already receive `Conversation` rows built from this view (Queue through `conversationsActiveResource` / `conversationsGoneResource`, History through the `queryConversations` endpoint), so the field reaches them with no extra read.
- Why a join rather than a client-side join on `tasksResource`: the History list reads from the server, and `tasksResource` is an unbounded resource.

### 2. The short title: a task side-table owned by `task-title`

Store the short title in a side-table, following the `task-effort` template:
- `defineExtension(_tasks, "short_title", shape)`, which creates the table `tasks_ext_short_title`;
- a lookup-only `liveCollection("task-short-titles")` plus `serveCollection`;
- a web hook `useTaskShortTitle(taskId)` built on `useLiveRow`.

Row: `{ taskId, shortTitle, sourceTitle, updatedAt }`. `sourceTitle` is the full title the short title was made from. When it differs from the task's current title, the short title is **stale** and is not shown. So a rename can never leave a wrong short title on screen, even for a moment.

**Generating it: derive from the title, at a single entry point.**
- Titles are written through several paths, many with no Haiku call:
  - `add_task` via MCP (`titleAuto:false`);
  - the toolchain job;
  - `handle-launch-task`;
  - manual edits through `updateTask`;
  - the poller's `updateTaskTitle`.
- So the short title is made **from the current title**, not from the description, and is triggered by a new event:
  - `tasks.titleChanged` (`defineTriggerEvent` in `tasks-core/server/internal/tables-events.ts`, following `taskStatusChanged`);
  - emitted at the three title write points in `tasks-core/server/internal/mutations/tasks.ts`: `createTaskOn`, `updateTaskOn` when the patch contains a title, and `updateTaskTitle` when the CAS write succeeded.
- A new job `task-title.short` (`Trigger({ on: taskTitleChanged, do: … })`) does the work:
  1. re-reads the task and returns without doing anything if the title changed since the event was emitted (a newer event is on its way);
  2. calls a new `generateShortTitle(title)` in `generate-title.ts`: `runClaudePrint` with Haiku and a "≤3 words, same meaning, one line" prompt, parsed like `generateTaskTitle`;
  3. validates the result. It must have 1–3 words and be non-empty; otherwise nothing is written and the full title shows;
  4. upserts the row with `sourceTitle = title` only if the task's title still equals `title`.
- One trade-off: a task created with a fallback title that Haiku then upgrades costs two short-title calls, the first of which is thrown away. If `defineJob` supports a delay or a per-key singleton, use it to merge the two calls; otherwise accept the extra call.
- Titles of three words or fewer skip Haiku: the short title is the title itself.

**Backfill.** Follow `pages/content-search`:
- a `defineWarmup` enqueues a `dedup:"singleton"` job;
- the job fills in tasks that have no fresh row, **limited to tasks with a conversation active in the last 30 days**, so the first boot does not make thousands of Haiku calls;
- older tasks show their full title in `short` mode.

### 3. The setting (config only)

In the conversations list plugin `plugins/conversations/plugins/conversations-view/plugins/data-view`:
- `shared/config.ts`: `defineConfig({ fields: { titleMode: enumField(["conversation","task","short"], default "conversation", label "Conversation list title") } })`, registered on web and server through `ConfigV2`, following `shell/global-action-bar/shared/config.ts`. It appears only in Settings → Config.
- **No `DataViewSlots.Setting` and no view option.** Nothing in the list's gear menu changes.

### 4. The list row reads it

- In the same plugin's `web`, add one row component, `SidebarConversationItem({ conv })`. It is exported from the barrel so the Queue and History children (which already import that barrel) share it. It:
  - reads the mode with `useConfig`;
  - computes `{ label, full }` from the rules in the table above:
    - `short` shows `shortTitle` only when `sourceTitle === conv.taskTitle`; otherwise it shows `taskTitle`;
    - a short title still loading shows the full task title, which is true for this task; this is not the "stand-in value" pattern the rules forbid;
    - `taskTitle` is used as is (the poller already replaces "Untitled");
  - renders `<ConversationItem conv={conv} layout="line" title={…} />`.
- `ConversationItem` / `ConvTitle` get an optional `title?: { label: string; full: string }` prop. When it is absent, the title is `conversationTitle(conv)`, so every other caller is unchanged.
- Both list sources call the shared component in their `renderRow`:
  - `queue/web/components/sidebar-queue.tsx:41`;
  - `history/web/components/sidebar-history.tsx:90`.

Two open checks for the build:
- **Dependencies:** `conversations-view/data-view/web` imports `tasks/task-title/web`. That is fine as long as `task-title`'s web barrel imports nothing from `conversations` web; run `plugin-boundaries` to confirm there is no cycle.
- **Performance:** check that per-row `useLiveRow` on a lookup-only collection combines rows into one subscription for a set of ids. If it does not, each source reads the short titles for its visible rows with one `useLive({ ids })` and passes them down.

## Files

- `plugins/tasks/plugins/tasks-core/`: `server/internal/views.ts`, `core/internal/schema.ts`, `server/internal/tables-events.ts`, `server/internal/mutations/tasks.ts`
- `plugins/tasks/plugins/task-title/`: `server/internal/generate-title.ts` (`generateShortTitle`), new `server/internal/short-title-{tables,job,backfill}.ts`, `shared/schemas.ts`, new `web/` barrel (`useTaskShortTitle`)
- `plugins/conversations/plugins/conversations-view/plugins/data-view/`: new `shared/config.ts`, config registration in `web/index.ts` + `server/index.ts`, new `SidebarConversationItem`; `plugins/{queue,history}/web/components/sidebar-*.tsx` (`renderRow`)
- `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx` (optional `title` prop)

## Out of scope

- The History list's server search keeps matching the conversation title only. Adding `taskTitle` to its searchable fields is a later step.
- The per-conversation title stays stored and is still what `conversation` mode shows.
- Chips, `ConversationRow`, the attempt pane and tab titles keep the conversation title.

## Verification

1. `./equin build`; `./equin check` passes (boundaries, migrations-in-sync for the new side-table, and `type-check`, which catches every row type missing `taskTitle`).
2. `./equin test plugins/tasks/plugins/task-title`: unit tests for `generateShortTitle`'s parsing and validation (≤3 words, quotes stripped, fallback) and for the resolver's stale / loading / mode cases.
3. `query_db`: `select t.title, s.short_title, s.source_title from tasks t join tasks_ext_short_title s on s.task_id = t.id limit 20`. Create a task through `add_task` and one through the UI, rename one, and confirm each row updates to match the new `source_title`.
4. Screenshots of the `/agents` list in each mode: `screenshot.ts --path /agents --out /tmp/title-<mode>` after switching the setting in Settings → Config. Check that hover shows the full title, that the list's gear menu has no new entry, and that a chip in a conversation and the task's attempts section still show the conversation title.
