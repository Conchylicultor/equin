# Dispatch an agent from a `/todo` card

## Context

A `/todo` card is the page's **actionable** lane — "work an agent still has to
do" — but today it is inert prose in a dashed box. Nothing on the card can start
that work, nothing records that it was started, and an agent reading the page
through `read_page` cannot tell a TODO somebody is already on from one nobody
has touched.

The `/prompt` block already proves out the whole launch path (block → task →
attempt → conversation, with the task↔block link as the single source of truth),
so this is that shape applied to a container card, plus two things `/prompt` does
not have:

1. **One task per card, many attempts.** A second dispatch from the same TODO
   opens a new attempt on the *same* task, not a second task.
2. **The state is visible to agents.** `read_page` emits the linked task's id and
   status as attributes of the `<todo>` tag, which means the markdown must be
   able to carry a fact that does not live in the block's `data`.

Outcome: from a TODO card you launch an agent (with free-form extra context), the
card then shows the task's live status, one click opens the run, and every agent
that reads the page sees `<todo task_id="…" status="…">`.

---

## What the user sees

**Before a launch.** The card's ⏱ glyph becomes clickable (it is inert today).
Clicking it — or picking **Dispatch an agent** from the ⠿ rail menu on the line
the card borrows — opens a small panel: the page/block it will hand over, a box
for extra context, a preprompt picker, and the usual `[model ▾][▶]` launch
control. Launching pushes the new conversation into a column beside the page.

**After a launch.** The glyph becomes the task's status icon (in-progress,
needs-action, done, dropped …). The panel now leads with the task's title, its
status chip, and a row that opens the **latest conversation** of the task; the
dispatch form is still there, labelled *Dispatch another agent* — using it adds
an attempt to the same task.

**When the task settles.** `done` repaints the card's dashed box from warning to
success; `dropped` fades it to muted. The TODO stops shouting at the reader
without disappearing.

**What an agent sees.** `read_page` emits

```
<todo task_id="task-1786112093-ab12" status="in_progress">
  Fix the parser for UTF-16 input
  - [ ] decode.ts
</todo>
```

and nothing extra on a TODO nobody has dispatched.

---

## Design

Four pieces. Only the second and third touch shared machinery; both are generic
and name no block type.

### 1. `page/annotations/todo/plugins/task-link` — the link, the launch, the panel

`todo` becomes an umbrella with one sub-plugin, exactly as `agent-notes` is an
umbrella over `authorship`. Same argument: the record is about the CARD, must
survive edits, and is read by a second surface — it does not belong in the
block's `data` (which is `z.object({})` and must stay so).

**Table** (`server/internal/tables.ts`) — mirrors
`apps/pages/starred`'s `defineExtension(_blocks, …)`:

```ts
export const todoTask = defineExtension(
  _blocks,
  "todo_task",
  { taskId: text("task_id").notNull().references(() => _tasks.id, { onDelete: "cascade" }) },
  { indexes: (t, b) => [b.index("task").on(t.taskId)] },
);
```

`page_blocks_ext_todo_task(parent_id PK → page_blocks CASCADE, task_id → tasks
CASCADE)`. The **PK on the block id is what makes "one task per TODO" a fact of
the schema** rather than a rule the endpoint remembers — which is the whole
reason this is an extension on `_blocks` and not a copy of `/prompt`'s 1:N
`tasks_ext_prompt_block`. Both FKs cascade: the row is a pure link and means
nothing once either end dies (deleting the task frees the card for a fresh
launch). `growth-bound.ts` asserts the block cascade with `markCascadeBounded`,
copied verbatim from `authorship`.

**Resource** — keyed by `{ blockId }`, value `TodoTaskLink[]` of length 0 or 1,
`identityTable: "page_blocks_ext_todo_task"`, no `affectedIds` branch. This is
`agentNotesAuthorsResource` byte-for-byte in shape: point membership, so only a
mounted card pays, and a FULL load is one row. Not `bootCritical` (the card
mounts route-scoped with the page). Status/title are NOT in this resource — the
web hook joins the already boot-critical `tasksResource` by id, the same join
`prompt/block`'s chips make against `attemptsResource`.

**Endpoint** — `POST /api/todo-blocks/:blockId/task`, body `{ context?: string }`,
response `{ taskId, prompt }`. Idempotent, and it is the *only* place the
one-task rule is exercised:

- `loadBlockScope(blockId)` (from `markdown-apply/server`) resolves the page and
  proves the block is live; assert `row.type === todoBlock.type`.
- reuse the linked task if the extension row is there, else `createTask` +
  `scheduleTaskTitleUpdate` + `setTaskCategory(PAGES_CATEGORY_ID)` +
  `todoTask.upsert` — the `createTaskFromPromptBlock` body, adapted. The title
  seed is the card's own first line, not the composed prompt, so Haiku has
  something real to work from.
- compose the prompt and return it. The client hands `{ taskId, prompt }` to
  `LaunchControl`, and `createConversation` with a `taskId` and no `attemptId`
  **already mints a new attempt** (`conversations/server/internal/lifecycle.ts`)
  — requirement 3 needs no new code.

`PAGES_CATEGORY_ID` is imported from `page/prompt/link/server`, which owns the
`TaskCategory({ id: "pages" })` registration. One category, one registration.
(Its living in a plugin named "prompt link" is pre-existing and mildly
misfiled — worth a follow-up, not a change here.)

**The prompt** (server-composed, card text kept short):

```
Work on the TODO card `block-77` in equin page `page-4`.

<todo>
Fix the parser for UTF-16 input
- [ ] decode.ts
</todo>

Read the page with read_page("page-4") for the surrounding context. When you are
done, write your findings back with edit_page as an <agent-note> card placed at
the END of that TODO card.

<the extra context typed into the panel>
```

The card's contents come from `readBlockAsMarkdown(blockId)` (its children, no
title banner), trimmed to a modest cap with an explicit "…truncated, read the
page" line — never silently cut. The ids are authoritative; the inlined text is
a convenience snapshot and says so.

### 2. `page/editor` markdown — tags may carry externally-owned attributes

`status` and `task_id` are facts about the row that live in another table, so
neither the derived attribute projection (which reads `data`) nor a declared
`attrs(data, ctx)` can produce them. The generalization already exists in
embryo: `BlockTag.identified` reserves `id`, emits it from `ctx.id`, and
`takeRef` lifts it back off *before* `dataOf` ever sees it. This adds the same
mechanism for a declared set of names:

- `BlockTag.annotated?: readonly string[]` — attribute names supplied from
  outside `data`, reserved in both directions.
- `MarkdownNode.annotations?: Readonly<Record<string, string>>` and the matching
  `MdSerializeCtx.annotations` — the values, when the caller has them.
- **Serialize** (`tagAttrs`): emit the declared names present in
  `ctx.annotations`, right after the reserved `id`, before the type's own attrs.
  Absent value ⇒ attribute omitted (an id-less/annotation-less forest — the
  clipboard — is the ordinary case and must still serialize).
- **Parse** (`claimTag`): delete every `annotated` name from the attribute record
  before `dataOf`, exactly where `takeRef` deletes `id`. This is what keeps the
  round trip closed: the void `todoDataSchema.strict()` would 400 on a stray
  `status` key, and the aligner would see a changed `data` for an untouched card.
- Three loud failures, mirroring `identified`'s: an `annotated` name colliding
  with a schema field, with `data`, or with `id` throws at tag resolution; a
  type's own `attrs` emitting a reserved name throws at serialize; a node
  carrying an annotation the tag never declared throws at serialize (rather than
  emitting an attribute that would come back as a `data` key).

**These attributes are read-only.** An agent editing `status="done"` in a
document has that edit discarded — the parser is pure and cannot know the current
value. Stated in the tool description, not silently absorbed.

`todoBlock.markdown` becomes `{ tag: { body: "children", annotated: ["task_id",
"status"] } }`. Values are the raw `TaskStatus` enum (`new` / `in_progress` /
`need_action` / `attempted` / `done` / `held` / `dropped`), so what an agent
reads is what the task list shows, with no second vocabulary.

### 3. Who fills them in: a server-side provider registry

`page/editor/server`'s `block-registry.ts` gains a third contribution beside
`BlockData` / `InlineToken`:

```ts
Editor.BlockAnnotation: defineServerContribution<{
  resolve(rows: readonly { id: string; type: string }[]):
    Promise<ReadonlyMap<string, Record<string, string>>>;
}>("page.block-annotation")
```

plus `resolveBlockAnnotations(rows)`, which fans out over the contributions,
merges, and throws on two providers claiming one `(block, attribute)` pair.

`markdown-apply`'s `readBlockAsMarkdown` / `readPageAsMarkdown` await it **after
`redact`** (a hidden card costs nothing and leaks nothing) and pass the map into
`markdownNodesOfRows(rows, rootId, annotations?)`, which stamps it onto each
node. The engine stays audience-agnostic and type-agnostic; `agent-access` needs
no change beyond its tool prose. `task-link` contributes the one provider today:
filter `type === "todo"`, one `WHERE parent_id IN (…)` joined to `tasks`,
bounded by the page.

The planner is unaffected: a void card's alignment key is
`type ␀ stableJson(data)` and annotations are not in `data`; the only place a
node is re-serialized (`plan.ts`'s `<page id="…"/>` pointer comparison) is
page-shell-only.

### 4. The card's UI

**The panel** (`web/components/todo-dispatch.tsx`) is registered twice from the
todo plugin — as the anchor's `sections` and as `BlockFrameMeta.menu` — which is
the documented convention for a container ("the rail is where a user looks for
block actions, the glyph is where they look for the glyph").

`primitives/launch` gets a small extraction: the body of `LaunchAgentPopover`
(context editor + `PrepromptSelect` + `LaunchControl`) becomes an exported
`LaunchAgentForm`, and `LaunchAgentPopover` becomes `InlinePopover` + that form.
One form, two hosts — a popover inside the anchor's popover is not an option.
The form takes `openAfterLaunch` (default `false`, preserving today's callers);
the TODO panel passes `openAfterLaunch` with `openMode="push"` and closes the
anchor popover via the `close()` the shell hands it.

**The glyph** (`todo-anchor.tsx`) follows `AgentNotesAnchor`'s three-state split:
no `blockId`/`editor` (read-only surfaces) ⇒ today's static `MdPendingActions`;
otherwise a sub-component subscribes to the link and renders
`STATUS_META[status].icon` from `tasks/task-status/web` — one source of truth for
status icon and tint, never a second mapping.

**The box** (`todo-frame.tsx`) needs the row id, which `BlockFrameProps` does not
carry. Add `blockId?: string` to it, mirroring `BlockAnchorProps.blockId` (added
for exactly this reason: "appearance that depends on something stored BESIDE the
row"), and pass it at the two dispatch sites — `span.block.id` in
`block-editor.tsx`, `node.id` in `read-only-blocks.tsx`. The frame then paints
`warning` (default), `success` (done), or `muted` (dropped), semantic tokens
only.

---

## Files

**New** — `plugins/page/plugins/annotations/plugins/todo/plugins/task-link/`:
`CLAUDE.md`, `package.json`, `shared/{schemas,endpoints,index}.ts`,
`server/{index.ts,internal/{tables,growth-bound,resource,mutations,routes}.ts}`,
`web/{index.ts,hooks.ts,components/todo-dispatch.tsx}`. Copy the file layout from
`agent-notes/plugins/authorship` and the mutation body from
`prompt/plugins/link/server/internal/mutations.ts`.

**Changed**

| File | Change |
|---|---|
| `page/editor/core/markdown.ts` | `BlockTag.annotated`, `MarkdownNode.annotations`, `MdSerializeCtx.annotations`; emit in `tagAttrs`, strip in `claimTag`, guards in `resolveTag` |
| `page/editor/core/markdown.test.ts` | round trip with annotations; strip-on-parse; each of the three throws |
| `page/editor/server/internal/block-registry.ts` | `Editor.BlockAnnotation` + `resolveBlockAnnotations` |
| `page/editor/web/types.ts` + `components/block-editor.tsx` + `read-only-view/web/components/read-only-blocks.tsx` | `BlockFrameProps.blockId` and its two pass-throughs |
| `page/markdown-apply/core/flatten.ts` | optional `annotations` arg on `markdownNodesOfRows` |
| `page/markdown-apply/server/internal/read.ts` | resolve annotations after `redact`, pass them in |
| `page/annotations/todo/core/todo-block.ts` | `markdown.tag.annotated: ["task_id", "status"]` |
| `page/annotations/todo/web/{index.ts,components/*}` | status-aware glyph + tint, `sections` + `menu` registration |
| `primitives/launch/web/components/launch-agent-popover.tsx` | extract `LaunchAgentForm`, add `openAfterLaunch` |
| `page/annotations/agent-access/.../mcp-tools.ts` | `read_page` prose: some tags carry read-only, externally-owned attributes; write them back unchanged |
| `CLAUDE.md`s | `todo` (now an umbrella), new `task-link`, `editor` (markdown section), `markdown-apply`, `container`/`annotations` cross-refs |

---

## Verification

1. `./equin build`, then open a page at `http://<worktree>.localhost:9000`.
2. Type `TODO ` to mint a card, write a line in it. Click the ⏱ glyph → panel
   opens; type extra context; launch. A conversation column opens; the glyph
   turns into the in-progress icon.
3. Re-open the panel → task title, status chip, a row opening the newest
   conversation. Dispatch again → **same task, second attempt**: check with
   `query_db`:
   `select t.id, t.status, count(a.id) from tasks t join attempts a on a.task_id = t.id join page_blocks_ext_todo_task x on x.task_id = t.id group by 1,2;`
4. `read_page` the page (MCP) → the card comes back as
   `<todo task_id="…" status="…">`; a TODO with no task has neither attribute.
5. `edit_page` feeding that exact text back → `survived` only, `created: 0`,
   `deleted: 0` (the reserved attributes did not become `data`, and the card kept
   its row).
6. Mark the task done in the task list → the card's box turns green live, and the
   next `read_page` says `status="done"`.
7. Delete the task → the link row cascades, the card returns to plain warning,
   and a fresh dispatch mints a new task.
8. `bun test plugins/page/plugins/editor/core/markdown.test.ts` and
   `./equin check`.

## Stated bounds

- **Reserved attributes are read-only.** An agent that edits `status=` in a
  document is ignored (documented in `read_page`); completing a TODO is a human
  action in the task list, or an agent action through the task tools.
- **A card is bound to one task for the task's lifetime.** There is no "detach"
  affordance; deleting the task is the escape hatch. Worth revisiting only if
  re-binding turns out to be a real workflow.
- ~~**The `<todo>` tag stays un-`identified`.**~~ **Reversed during
  implementation, at the user's call.** The tag is `identified`, so `read_page`
  emits `<todo id="…" task_id="…" status="…">`. Two reasons, and the second is
  the stronger one the original bound missed: an agent handed its card's id in
  its prompt can now find that card in the document, and — because every void
  card's content key is `type ␀ {}` — the pin is what stops `markdown-apply`'s
  aligner handing one card's row, and with it its task link, to another.
