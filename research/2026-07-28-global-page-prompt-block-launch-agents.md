# Launching agents from a page: the `/prompt` block

## Context

Today an agent can only be launched from the agent-manager surfaces (task list,
task header, conversation view) or from the global **Improve** popover. A page is
where thinking actually happens — a design doc, a checklist, a spec — and there is
no way to turn a line of that thinking into an agent run without leaving the page,
retyping the prompt into a task form, and losing the connection back to the
document that motivated it.

This adds a `/prompt` block type to the page editor: **the block is the prompt**.
Its text is ordinary page content — editable, formattable, versioned, searchable
like any other block — and it carries a launch control. Launching creates a task
stamped with a new `pages` meta-category (alongside `conversations`, `system`,
`agents`, `improvements`, `reports`) plus metadata recording the page and block it
came from. The block then tracks every conversation it launched; clicking one opens
it as a column beside the page.

Explicitly **out of scope** (a follow-up task): feeding the surrounding page text
to the agent as context. For now the agent is launched with the block's own text as
its prompt.

## Design

### Why a text-bearing block, not a popover

`defineBlock` already supports everything a prompt needs — the shared
`BlockTextEditor` (Lexical, marks, inline `[[page]]`/`@date` tokens, CRDT text,
undo), a `marker` for the leading glyph, and declarative Enter/Backspace knobs. So
the prompt is just `textBlockSchema({})` content and the block renderer adds one
row of chrome: a `LaunchControl` and the launched-conversation chips. This is the
`callout` block's exact shape (tinted box + `BlockTextEditor` + a marker), and it
makes the "page text as context" follow-up trivial — the prompt already lives in
the document tree.

### The task↔block link is the single source of truth

The block does **not** store task ids in its `data`. A `tasks_ext_prompt_block`
entity-extension (1:1 with a task, FK CASCADE on task delete) stores
`{ pageId, blockId }`, and the block derives its tasks by reading a live resource
keyed by `blockId`. One direction of truth, so a deleted task disappears from the
block automatically and the two can never drift.

`pageId`/`blockId` are **plain text columns with no FK to `page_blocks`** — by
design. A task is real work and must survive its originating block being deleted;
a CASCADE would destroy it and a `SET NULL` would silently lose the provenance.
The consequence is a possibly-dangling `blockId`, which both readers already handle
naturally (block-side query returns nothing; task-side section renders nothing).

### Plugin layout

Three plugins, split so that no dependency edge points from `page/` back up into
`apps/`:

```
plugins/page/plugins/prompt/                 # umbrella, no runtime of its own
├── plugins/link/                            # the task↔block link + the "pages" category
│   ├── shared/   resource descriptor
│   ├── core/     endpoint contracts
│   ├── server/   tasks_ext_prompt_block, resource, routes, TaskCategory("pages")
│   └── web/      useBlockPromptTasks(blockId), createPromptTask()
└── plugins/block/                           # the `prompt` block type
    ├── core/     defineBlock handle
    ├── web/      renderer (BlockTextEditor + LaunchControl + conversation chips)
    └── server/   Editor.BlockData(promptBlock)

plugins/apps/plugins/pages/plugins/prompt-origin/   # TaskDetail.Section backlink
```

`link` is separate from `block` because two unrelated UIs consume it (the block
renderer and the task-detail section), and the task-detail section must not drag
the whole block renderer into its closure.

`prompt-origin` lives in the **pages app** tree, not under `page/`: it navigates to
`pageDetailPane`, which the pages app owns. Putting it under `page/` would create a
`page → apps` edge for no reason. No cycles either way (`tasks`/`conversations`
never import `page`).

## Implementation

### 1. `plugins/page/plugins/prompt/plugins/link`

**`server/internal/tables.ts`** — mirror `tasks/task-effort` byte-for-byte:

```ts
export const promptBlock = defineExtension(_tasks, "prompt_block", {
  pageId: text("page_id").notNull(),
  blockId: text("block_id").notNull(),
});
export const _tasksPromptBlockExt = promptBlock.table;
```

`defineExtension` has no index option; the reverse `WHERE block_id = X` lookup is a
seq scan over a table domain-bounded to one row per prompt-launched task. State
that in a comment. If it ever needs an index, the structural fix is an `indexes`
option on `defineExtension`, not a hand-written migration here.

**`shared/resources.ts`** — the reverse lookup is keyed by a *foreign* column, so it
cannot use `windowQueryResource`'s `point` (whose `by` must be the identity pk).
The sanctioned shape is the hand-written keyed resource, copied from
`pushesByAttemptResource` (`plugins/tasks/plugins/tasks-core/server/internal/resources.ts:121`):

```ts
export const blockPromptTasksResource = keyedResourceDescriptor<
  PromptTaskLink[], { blockId: string }
>("prompt-block-tasks", z.array(PromptTaskLinkSchema), [], (r) => r.taskId);
```

**`server/internal/resource.ts`**:

```ts
export const blockPromptTasksServerResource = defineResource(blockPromptTasksResource, {
  identityTable: "tasks_ext_prompt_block",
  loader: async ({ blockId }, ctx) =>
    ctx?.affectedIds
      ? db.select(sel).from(t).where(and(eq(t.blockId, blockId), inArray(t.parentId, [...ctx.affectedIds])))
      : db.select(sel).from(t).where(eq(t.blockId, blockId)),
});
```

**`core/endpoints.ts` + `server/internal/handle-create.ts`** —
`POST /api/prompt-blocks/tasks`, body `{ pageId, blockId, prompt }`, response
`{ taskId }`. The handler mirrors `handleCreateChain`'s task-creation block
(`plugins/tasks/server/internal/handle-create-chain.ts:96-112`) and
`registerReportsInvestigation`'s create+stamp pattern:

```ts
const fallbackTitle = synthesiseTitleFallback(body.prompt);
const task = await createTask({ title: fallbackTitle, titleAuto: true,
                                description: body.prompt, author: "user" });
scheduleTaskTitleUpdate(task.id, body.prompt, fallbackTitle);
await setTaskCategory(task.id, PAGES_CATEGORY_ID);
await promptBlock.upsert(task.id, { pageId: body.pageId, blockId: body.blockId });
return { taskId: task.id };
```

**`server/index.ts`** — `Resource.Declare(...)`, the route, and
`TaskCategory({ id: "pages", label: "Pages", order: 5 })` (existing orders:
conversations 0, system 1, agents 2, improvements 3, reports 4).

**`web/`** — `useBlockPromptTasks(blockId)` over `useResource(blockPromptTasksResource, { blockId })`,
and `createPromptTask(body)` via `fetchEndpoint`.

### 2. `plugins/page/plugins/prompt/plugins/block`

**`core/prompt-block.ts`** — copy `toggle`'s knob set (`plugins/page/plugins/toggle/core/toggle-block.ts`),
which is the closest working precedent:

```ts
export const promptBlock = defineBlock({
  type: "prompt",
  schema: textBlockSchema({}),
  label: "Prompt",
  icon: MdAutoAwesome,
  aliases: ["agent", "ask", "launch", "claude", "ai"],
  empty: () => ({ text: [] }),
  placeholder: "Ask an agent…",
  splitInto: "text",                 // Enter at end → a plain paragraph, not another prompt
  resetToOnBackspaceAtStart: "text",
  breakOutOnEmptyEnter: "text",
  gutterFirstLineCenter: "calc(var(--space-xs) * 2 + var(--doc-lh-body) / 2)",  // matches callout's padded box
});
```

v1 prompt = **this block's own text only**. Shift+Enter gives a soft break within
the block. Multi-block prompts arrive with the page-context follow-up, where the
natural design is toggle's `splitChildWhenExpanded: { childType: "text" }` plus
serializing the subtree.

**`web/components/prompt-block.tsx`** — structurally `callout-block.tsx` plus a
footer row:

```tsx
export function PromptBlock({ block, isFocused, editor }: BlockRendererProps) {
  const data = promptBlock.parse(block.data);
  const links = useBlockPromptTasks(block.id);
  return (
    <Inset x={BLOCK_INSET} y="xs">
      <Surface level="raised">
        <BlockTextEditor block={block} isFocused={isFocused} editor={editor}
          inset={false} marker={<MdAutoAwesome className="icon-auto" />}
          placeholder="Ask an agent…" />
        <Line>
          <LaunchControl
            size="icon"
            openMode="push"
            getRequest={async () => {
              const prompt = plainOf(data.text);
              const { taskId } = await createPromptTask({
                pageId: block.pageId, blockId: block.id, prompt,
              });
              return { taskId, prompt };
            }}
          />
          <Fill><Cluster>{/* conversation chips */}</Cluster></Fill>
        </Line>
      </Surface>
    </Inset>
  );
}
```

Key points:

- **The prompt text comes from the client, not the block row.** The `doc → data.text`
  projection lags ~1s behind the CRDT doc, so a launch right after typing would send
  stale text. `plainOf(data.text)` is what the user sees rendered. (`plainOf` is
  exported from `page/editor/core`.)
- **`LaunchControl`'s `getRequest` is the designed seam** for exactly this
  create-then-launch prep (`plugins/primitives/plugins/launch/web/components/launch-control.tsx`).
  It gives the split model-dropdown + ▶ button, `mod+N` shortcuts, the default-model
  memory, and it opens `conversationPane` with `{ mode: "push" }` after
  `POST /api/conversations` returns — a right-hand Miller column, since Pages mounts
  `<MillerColumns/>` unconditionally with no full-surface pane list.
- **Conversation chips**: read `useResource(attemptsResource)` (global, boot-critical),
  filter to the link's task ids, and flatten `attempt.conversations` — the exact
  read `task-events.tsx` performs, so no new resource is needed. Each chip opens
  `openPane(conversationPane, { convId }, { mode: "push" })`, with active-row
  highlighting derived from `conversationPane.useRouteEntries()`.
- Do not hand-roll the chip row if it grows past transient chrome — but a handful of
  status chips beside a launch button is chrome, not a domain-record collection, so
  `Cluster` + `Badge` is correct here (no `data-view` obligation).

**`server/index.ts`** — `Editor.BlockData(promptBlock)`, one line, mirroring
`plugins/page/plugins/callout/server/index.ts`.

### 3. `plugins/apps/plugins/pages/plugins/prompt-origin`

A `TaskDetailSlots.Section` contribution (`{ id: "prompt-origin", label: "Origin" }`)
that reads the task's link row and renders a `LinkChip` with the page title, opening
`openPane(pageDetailPane, { pageId }, { mode: "push" })`. Renders nothing when the
task has no link row, or when the page no longer exists.

This needs a **task-keyed** read (`WHERE parent_id = taskId`), which the block-keyed
resource above does not serve. Add a second small read to `link`: reuse the
`task-category` precedent — a plain `queryResource` over the whole extension table
keyed by `parentId`, with the justifying comment the contract requires ("bounded by
the domain — at most one row per task, co-bounded with the already boot-critical
unbounded-legacy `tasks` resource").

## Files

New:
- `plugins/page/plugins/prompt/plugins/link/{shared,core,server,web}/`
- `plugins/page/plugins/prompt/plugins/block/{core,web,server}/`
- `plugins/apps/plugins/pages/plugins/prompt-origin/web/`
- a `package.json` + `CLAUDE.md` per plugin (copy `plugins/page/plugins/callout/package.json`)

Modified: none. Every plugin is discovered from the filesystem by `./equin build`;
never hand-edit `web.generated.ts` / `server.generated.ts`.

Reference implementations to copy shape from, in order of usefulness:
- `plugins/page/plugins/callout/` — the whole 4-file block-plugin shape
- `plugins/page/plugins/toggle/core/toggle-block.ts` — the Enter/Backspace knobs
- `plugins/tasks/plugins/task-effort/` — extension table → resource → endpoint → hook
- `plugins/tasks/plugins/tasks-core/server/internal/resources.ts:121` — the foreign-key-keyed resource
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx` — attempts→conversations read + pane opening
- `plugins/tasks/plugins/reports-investigation/server/internal/register.ts` — create task + stamp category

## Verification

1. `./equin build` — regenerates migrations (a new `tasks_ext_prompt_block`
   table), the plugin registries, and the plugin docs. Then `./equin check`.
2. In `http://<worktree>.localhost:9000/pages`, open a page, type `/prompt`, confirm
   the block appears in the slash menu and converts. Type a prompt.
3. Click ▶. Expect: a conversation pane opens as a right-hand column, and a chip for
   it appears in the block.
4. `query_db`: `SELECT * FROM tasks_ext_prompt_block` — one row with the right
   `page_id`/`block_id`; `SELECT * FROM tasks_ext_category WHERE category='pages'` —
   the stamped task.
5. Open the task in the agent manager: the **Origin** section shows the page; clicking
   it opens the page pane. The task list groups it under a **Pages** category.
6. Reload the page — the chip is still there (derived from the link, not client state).
   Launch a second agent from the same block — two chips.
7. Delete the block, then the page: the task survives, the Origin section renders
   nothing, no crash.
8. E2E: `plugins/page/plugins/prompt/plugins/block/e2e/prompt-launch.ts` driving
   insert → type → launch → assert the conversation column, using the shared
   `e2e-harness` helpers.

## Follow-ups (not this task)

- Feed the surrounding page as context to the launched agent — the reason the prompt
  lives in the document tree. Likely `splitChildWhenExpanded` so a prompt can span a
  subtree, plus `serializePageContent` on the server.
- If a second surface ever wants to back-link a task to its origin (a mail thread, a
  Sonata score), generalise `tasks_ext_prompt_block` into a `TaskOrigin` registry
  rather than adding a second bespoke extension.
