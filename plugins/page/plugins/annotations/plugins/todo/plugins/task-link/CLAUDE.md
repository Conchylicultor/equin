# task-link

**The task a TODO card dispatched an agent onto**, the launch that creates it,
and the panel behind the card's glyph.

A sub-plugin of [`todo`](../../CLAUDE.md) rather than part of the card itself,
for the reason [`authorship`](../../../agent-notes/plugins/authorship/CLAUDE.md)
is a sub-plugin of `agent-notes`: the record is about the CARD and must survive
edits to it, and it is read by a second surface (the markdown a `read_page`
returns) that has no business mounting a React panel. The card's own `data` is
`z.object({})` and must stay so.

Design: [`research/2026-08-07-page-todo-agent-dispatch.md`](../../../../../../../../research/2026-08-07-page-todo-agent-dispatch.md).

## A block-keyed extension, not a copy of `/prompt`'s link table

`page_blocks_ext_todo_task(parent_id PK → page_blocks, task_id → tasks)`.
`defineExtension` synthesizes its key (`blockId`, stored as `parent_id`) as the
PRIMARY KEY, and **that is what
makes "one task per TODO card" a fact of the schema** rather than a rule the
create endpoint remembers to check — i.e. rather than a rule two concurrent
dispatches can both pass. A second dispatch is an upsert onto the same key.

[`page/prompt/link`](../../../../../prompt/plugins/link/CLAUDE.md)'s
`tasks_ext_prompt_block` is 1:N on the TASK side, and that is right *there* and
wrong here, because the two blocks mean different things. A prompt block is a
re-runnable instruction — each run is its own piece of work. A TODO card is ONE
piece of work that may take several tries, and "several tries" is a concept that
already exists: `createConversation` with a `taskId` and no `attemptId` mints a
new attempt. So the many-runs axis costs this plugin no code at all — the
endpoint returns the same task id twice and the second launch is a second
attempt.

## Both FKs cascade — the opposite call its two neighbours make

`authorship` keeps a dangling `conversation_id`; `page/prompt/link` keeps a
dangling `block_id`. Both are STATEMENTS that stay true after one end dies ("an
agent wrote this card"; "this task came from a page"). This row is not a
statement, it is a **link**, and it means nothing once either end is gone:

- card deleted ⇒ nothing can ever read the row again;
- task deleted ⇒ the card is free for a fresh dispatch. That is also the only
  "detach" affordance the feature has, and keeping the row would instead bind the
  card forever to a task that no longer exists.

Growth is bounded by the `parent_id` cascade — `markCascadeBounded` asserts it at
module eval (boot-fatal). It sits in its own module because a barrel may hold no
statements and `tables.ts` must stay importable by drizzle-kit's schema loader,
which cannot pull in retention's `db`/`jobs` closure.

## The status is joined client-side, never stored

`todoTasks` (a row per dispatched card) carries the link and nothing
else — no title, no status. Those belong to the TASK: they change without the
link changing, and the browser already holds them on the boot-critical `tasks`
resource that the task list itself renders. Copying them here would make this row
a second, drifting answer to a question something else already answers, and every
status flip would have to remember to write two places. `useTodoTaskState` does
the join; the card's glyph then follows its task through every transition with
nothing stored on the card.

`todoTasks` is a lookup-only `liveCollection("todo-block-task", { row, id:
"blockId" })` — no default window, so it mints `todo-block-task:rows` alone —
served from the extension entity (`serveCollection(todoTasks, { from: todoTask
})`) and read with `useLiveRow(todoTasks, blockId)`: `found: false` is "not
dispatched". Each mounted card subscribes to its own id set, and the point
membership routes a dispatch to the card it wrote and no other. That routing is
the point: the seek per card is cheap, but there used to be one per open card
per write, and how many that is belongs to the page, not to this read. It
replaced the hand-written keyed `todoTaskResource` + `rowIdentity`
(`research/2026-09-26-global-live-values-migration-contract.md` §10).

The row id must be `blockId`, not `taskId` — see the declaration's comment in
`shared/schemas.ts`. `defineExtension` makes `parent_id` (the `blockId` wire
column) the table's single-column PRIMARY KEY, the change-feed hands the runtime
those PK values, and the point membership intersects them with each card's id
set — so an id in any other space would never intersect, and a cascade delete
would ship no removal.

## What the markdown provider emits

The `Editor.BlockAnnotation` contribution answers, for the rows a markdown read
is about to walk, with `task_id` and `status` for every dispatched `<todo>` card.
Those are the two attributes `todoBlock`'s tag declares in
`markdown.tag.annotated`, and they are the reason that mechanism exists: they are
facts about the card that live in another table, so neither the derived attribute
projection (which reads `data`) nor a declared `attrs(data, ctx)` could produce
them. What they buy is that an agent reading a page can tell a TODO somebody is
already on from one nobody has touched.

- **`status` is the raw `TaskStatus` enum** (`new` / `in_progress` /
  `need_action` / `attempted` / `done` / `held` / `dropped` / `blocked`), never a
  prettified label — so what an agent reads is the vocabulary the task list shows
  and the task tools accept, with no second dialect.
- **It is read from `tasks_v`, not `tasks`.** A task's status is COMPUTED (from
  its attempts, its conversations, its dependencies) and is no column of the base
  table. `readTaskStatus` answers for one id at a time, which would turn a page
  read into one round trip per linked card; the view is exported from
  `tasks-core/server` as `tasksView` so this can be one joined query.
- **Empty in, empty out.** A page with no TODO cards runs no query at all, rather
  than one that could only ever return nothing.
- **They are READ-ONLY**, and `claimTag` discards them on the way back in. A pure
  parser can neither tell an edited value from the one it emitted a minute ago nor
  write the table that owns it. `read_page`'s description says so generically —
  the rule is about externally-owned attributes as a family, not about TODO cards.

## The prompt is composed server-side, on every dispatch

`ensureTodoTask` reads the card through `readBlockAsMarkdown` — the same dialect
`read_page` hands the agent, so the snapshot in the prompt and what it re-reads on
the page are one text — and returns `{ taskId, prompt }`.

- **The card's text is not in the request body.** Unlike `/prompt`, whose text the
  client must send because the block row's `data.text` projection lags the CRDT
  doc by ~1s, a TODO card owns no text of its own: its content is its children,
  each with its own doc, and there is no single editor holding a fresher copy.
- **The inlined card is capped (~1500 chars) and SAYS SO when it was cut.** It is
  a convenience snapshot — the prompt tells the agent to go read the page, which
  is authoritative — so a long card would only push the instructions after it out
  of attention. A silent truncation would let an agent conclude the card asks for
  less than it does.
- **The prompt is recomposed on the reuse path too**, because the card has moved
  on since the first dispatch: a second agent must be told what it says now. Only
  the first call writes it to the task's `description`, so the task detail shows
  what the first agent was actually asked.
- **The title seed is the card's own first line, not the prompt.** The prompt
  opens with "Work on the TODO card `block-…`", so seeding from it would title
  every task after its own block id. The first line is the one thing in the whole
  payload a human wrote.
- **The category is `PAGES_CATEGORY_ID`, imported from `page/prompt/link`**, which
  owns the single `TaskCategory({ id: "pages" })` registration. One category, one
  registration; a second one here would be a duplicate id, not a new lane.

## The runs are one join, read by both surfaces

`useTaskConversations([taskId])` (tasks-core's, the one join every surface in the
repo uses) is the card's runs, oldest first, off the boot-critical `attempts`
resource. The foot renders all of them as chips; the panel takes `.at(-1)` as the
run its "open" row navigates to. One list, so the run the panel offers is by
construction the last chip at the foot.

Several runs per card costs nothing: `createConversation` with a `taskId` and no
`attemptId` mints a new attempt, so "Dispatch another agent" returns the same
task id and simply grows the list.

## The panel is one component registered twice

`TodoDispatch` renders as the anchor's `sections` and as the card's
`BlockFrameMeta.menu` — the documented container convention (the rail is where a
user looks for block actions, the glyph is where they look for the glyph). Its
second state is its first plus a header: the task's live title and status and a
row opening its newest conversation, with the same form below reading *Dispatch
another agent*. Transient chrome, not a DataView — one task line and one
conversation row off a `size-5` glyph, with no search / sort / filter to earn.

`TodoRuns` is the third registration — the card's `BlockFrameMeta.foot`, via
`todo`'s own `TodoFoot`, which is where the "no editor ⇒ render nothing" rule
lives. Chips, not a DataView, for the same reason: a handful of runs beside a
card, not a collection.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Reads the task a TODO card was dispatched onto (useTodoTask / useTodoTaskState, joined live to the tasks resource; the runs come from tasks-core's useTaskConversations) and renders the card's two dispatched surfaces — the dispatch panel behind its name, and the chips at its foot, one per run. Contributes no slot of its own; the todo card's anchor, rail menu and foot host them. Owns page_blocks_ext_todo_task: the ONE task a TODO card dispatches agents onto. The block-keyed link table (its primary key IS the one-task-per-card rule), the per-card live read, the idempotent dispatch endpoint that composes the agent's prompt, and the markdown provider that emits the card's task_id/status to read_page.
- Server:
  - Contributes:
    - `resource.declare` "todo-block-task:rows"
    - `page.block-annotation`
  - Uses:
    - `database.db`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entity-extensions.defineExtension`
    - `infra/retention.markCascadeBounded`
    - `network/live.serveCollection`
    - `page/editor._blocks`
    - `page/editor.Editor`
    - `page/markdown-apply.loadBlockScope`
    - `page/markdown-apply.readBlockAsMarkdown`
    - `page/prompt/link.PAGES_CATEGORY_ID`
    - `tasks/task-category.setTaskCategory`
    - `tasks/task-title.scheduleTaskTitleUpdate`
    - `tasks/task-title.synthesiseTitleFallback`
    - `tasks/tasks-core._tasks`
    - `tasks/tasks-core.createTask`
    - `tasks/tasks-core.tasksView`
  - DB schema: `plugins/page/plugins/annotations/plugins/todo/plugins/task-link/server/internal/tables.ts`
  - Entity extension of: `page/editor` (table `page_blocks_ext_todo_task`)
  - Exports (values):
    - `_pageBlocksTodoTaskExt`
    - `ensureTodoTask`
    - `todoTask`
    - `todoTasksServed`
  - Resources: `todo-block-task:rows` (keyed, point)
  - Routes: `POST /api/todo-blocks/:blockId/task`
- Web:
  - Uses:
    - `conversations/conversation-ui/chip.ConversationChip`
    - `conversations/conversation-ui/row.ConversationRow`
    - `infra/endpoints.fetchEndpoint`
    - `network/live.LiveRowResult`
    - `network/live.mapRow`
    - `network/live.useLive`
    - `network/live.useLiveRow`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/launch.LaunchAgentForm`
    - `primitives/live-state.combineResources`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/live-state.ResourceResult`
    - `primitives/loading.Loading`
    - `tasks/task-status.StatusBadge`
    - `tasks/tasks-core.useTaskConversations`
  - Exports (types):
    - `TodoTaskLink`
    - `TodoTaskState`
  - Exports (values):
    - `TodoDispatch`
    - `TodoRuns`
    - `useTodoTask`
    - `useTodoTaskState`
- Cross-plugin:
  - Imported by: `page/annotations/todo`
- Shared:
  - Exports (types):
    - `CreateTodoBlockTaskBody`
    - `TodoTaskLink`
  - Exports (values):
    - `createTodoBlockTask`
    - `TodoTaskLinkSchema`
    - `todoTasks`

<!-- AUTOGENERATED:END -->
