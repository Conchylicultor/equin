# +improve: queue a sequential task chain from one popover

## Context

The `+improve` toolbar button currently creates exactly **one** task per popover
submission. The user hit a real limitation: while typing an improvement
("Conversations launched through agents should have a chip with the name…"),
they realised they wanted a *prerequisite design pass* to land first
("Includes the conversations in 'Attempts'… let's design first."). The only way
to express that today is:

1. Submit the improvement → it lands as one task.
2. Navigate to the task pane.
3. Create a second parent task manually.
4. Wire the original task's dependency to point at the new parent.

That's four context switches for a sequence the user already had in their head.
The plumbing to express it cheaply already exists: `POST /api/tasks` accepts
`dependencies?: string[]` and `autoStart?: { model }`, and `armTaskAutoStart`
(in `plugins/tasks/server/internal/arm-auto-start.ts`) sets up per-dep
`tasks.maybe-launch` triggers that fire each task in order as its blockers
clear. **All that's missing is a UI that lets the user stack 2+ improvements
before submitting.**

This plan adds that UI inside the existing improve popover (no new plugin, no
new slot), with each "card" representing one task in a strict linear chain.

## UX design

### Decisions (from clarifying questions)

| | |
|---|---|
| Chain shape | Strict linear — top→bottom is execution order; each card is blocked by the one above. Drag to reorder. |
| Launch model | **Per-card chip** — each card carries its own Queue / Sonnet / Opus. |
| Form size | Same Popover, widened to ~480px, scrolls vertically when many cards. |

### Mockup

```
┌─────────────────────────────────────────────────┐
│ Improve this app                                │
│ ┌─────────────────────────────────────────────┐ │
│ │ ⋮⋮ ╭───────────────────────────╮  [Sonnet▾] │ │  ← card 1
│ │    │ Design status-chip pattern│            │ │
│ │    │ Includes Attempts, active │   ✕        │ │
│ │    │ vision, sidebar list…     │            │ │
│ │    ╰───────────────────────────╯            │ │
│ └─────────────────────────────────────────────┘ │
│              ↓ blocks                            │  ← chain connector
│ ┌─────────────────────────────────────────────┐ │
│ │ ⋮⋮ ╭───────────────────────────╮  [Opus  ▾] │ │  ← card 2
│ │    │ Apply chip to conv-list   │            │ │
│ │    │ sidebar                   │   ✕        │ │
│ │    ╰───────────────────────────╯            │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│              [+ Add task]                       │
│                                                 │
│ Context (applies to head)                       │
│ ☐ URL    ☐ Screenshot                           │
│ ─────────────────────────────────────────────── │
│           [ Cancel ]   [   Submit chain   ]     │
└─────────────────────────────────────────────────┘
```

### Interactions

- **Single-task case looks identical to today.** When there's one card, the
  layout is just the textarea + per-card chip. The "+ Add task" button and the
  chain connector only appear once a second card exists.
- **Per-card model chip.** A small segmented chip on the right of each card
  with `Queue` / `Sonnet` / `Opus`. Default for the first card is the user's
  last-used model (sonnet); subsequent cards inherit the previous card's choice
  on add. "Queue" means create-but-don't-arm — the task sits unarmed even when
  blockers clear; user launches it manually later.
- **Reorder.** A `⋮⋮` drag handle on the left of each card; drag-to-reorder via
  `@dnd-kit/sortable`. The chain edges always re-derive from card order
  (card[N].blockedBy = card[N-1].id).
- **Insert prereq above.** A small `+` icon appears between cards (and above
  the first card) on hover, inserts a new empty card at that position. This
  directly addresses the user's reported pain: "I realised I needed a prereq
  *before* this one."
- **Delete.** ✕ on each card; only shown when 2+ cards exist (single-card mode
  uses Cancel for the same effect).
- **Cmd/Ctrl-Enter** submits the whole chain (matches today's behaviour).
- **Empty cards block submit.** Submit button is disabled while any card has
  empty text. Trailing-empty cards are *not* auto-pruned — the user added them
  intentionally and we don't want to silently drop input.
- **URL / Screenshot toggles stay global.** They attach to the **head** task
  (the first to execute), since they capture "the context that prompted this
  whole chain." Per-card attachments are out of scope for v1.

### Why this UX over alternatives

- **Strict linear over free DAG.** 95% of real cases the user described are
  "do X before Y." A free DAG needs a per-card dependency picker which inflates
  the popover into something resembling the task-detail pane — defeating the
  point of a quick capture surface.
- **Per-card model over one-for-all.** The user's example is exactly the
  motivating case: queue a Sonnet design pass, then auto-launch the
  implementation with Opus once design lands. The infra already supports it
  (`armTaskAutoStart` accepts a per-task model), so exposing it costs us a
  small chip per card.
- **Popover grow over drawer-promote.** Drawer-promote requires a transition
  animation, a new pane registration, and breaks the keyboard flow. The
  popover already vertical-scrolls; a 2-3 card chain fits comfortably at 480px
  wide.

## Frontend changes

### State shape (was `value: string`, becomes `cards: Card[]`)

```ts
type ChainModel = "queue" | "sonnet" | "opus";

interface Card {
  localId: string;       // crypto.randomUUID() — used as dnd-kit id
  text: string;
  model: ChainModel;
}
```

Form state in `improve-button.tsx`:

```ts
const [cards, setCards] = useState<Card[]>(() => [makeEmptyCard("sonnet")]);
const [includeUrl, setIncludeUrl] = useState(false);
const [includeScreenshot, setIncludeScreenshot] = useState(false);
const [submitting, setSubmitting] = useState(false);
```

(Drop the `Submitting` discriminated union: with one Submit button the boolean
is enough.)

### Components

- **`ImproveForm`** (rewrite of `plugins/improve/web/components/improve-form.tsx`):
  hosts the SortableContext, the `+ Add task` button, the global Context
  toggles, and the Cancel / Submit chain footer.
- **`ImproveCard`** (new — `plugins/improve/web/components/improve-card.tsx`):
  one card. Drag handle, textarea (autosize via `rows` + `resize-y` like today),
  model chip on the right, ✕ delete (hidden when count===1).
- **`ChainConnector`** (new — `plugins/improve/web/components/chain-connector.tsx`):
  the small `↓ blocks` connector + hoverable insert-here `+`. Rendered between
  cards and above the first card.
- **`ModelChip`** (new — `plugins/improve/web/components/model-chip.tsx`):
  segmented `Queue / Sonnet / Opus` chip. Three small pill buttons in a flex
  row; selected pill uses the existing `Button` `default` variant, rest use
  `ghost`. Keeps it visually consistent with existing chips.

### Drag-and-drop

Reuse `@dnd-kit/core` and `@dnd-kit/sortable` (already in the workspace —
`plugins/primitives/plugins/tree/web/internal/tree-list.tsx:10` is the
reference). `verticalListSortingStrategy`. PointerSensor with a small
activation distance so a click on the textarea doesn't accidentally start a
drag. The drag handle is the explicit hit target (`⋮⋮` icon on the left); the
textarea itself is not draggable.

### Auto-grow popover width

Today the popover is fixed at `w-80` (320px). Bump the form root to
`min-w-[420px] max-w-[480px]`. The `PopoverContent` itself doesn't need width
overrides (it inherits from children).

## Server changes

### Request shape

`plugins/improve/shared/types.ts`:

```ts
export interface ImproveSubmitCard {
  text: string;
  launch: "sonnet" | "opus" | null;   // null = "queue", don't arm
}

export interface ImproveSubmitBody {
  cards: ImproveSubmitCard[];          // 1+ entries; index 0 is head
  url: string;                         // attached to head only (v1)
  attachmentIds: string[];             // attached to head only (v1)
}

export interface ImproveSubmitResponse {
  taskIds: string[];                   // in chain order
}
```

### Handler logic

`plugins/improve/server/internal/handle-submit.ts` becomes a loop that:

1. Validates each card has non-empty text; validates attachments exist (same
   as today, runs once before any task is created).
2. Iterates `body.cards` in order. For each card:
   - Calls `createTask({ parentId: IMPROVEMENTS_META_TASK_ID, title:
     synthesiseTitle(card.text), description: renderTaskDescription(...) })`.
     URL + attachments only render into the **head** task's description.
   - If index > 0, calls `addTaskDependency(task.id, taskIds[index-1])`.
   - If `card.launch` is set, calls `armTaskAutoStart({ taskId: task.id,
     model: card.launch, dependencies: index > 0 ? [taskIds[index-1]] : [] })`.
     For the head this enqueues `tasks.maybe-launch` immediately; for tail
     cards it installs per-dep oneShot triggers that fire when the previous
     card's task reaches `done` / `dropped`.
3. Inserts head's `_taskAttachments` rows after head creation (unchanged from
   today, just scoped to head).

The existing `createConversation` direct call goes away — `armTaskAutoStart`
+ the `tasks.maybe-launch` job already handles conversation creation
uniformly. This drops a code path and aligns the head with the rest of the
chain. (`improve-button.tsx:88`'s `void json; // reserved for follow-up` was
already unused, so dropping `conversationId` from the response is no
regression.)

### Required export

Add `armTaskAutoStart` to the `plugins/tasks/server/index.ts` barrel
(currently it lives in `internal/`). The improve plugin then imports
`{ armTaskAutoStart, addTaskDependency }` from `@plugins/tasks/server`.

`addTaskDependency` is already in `@plugins/tasks-core/server`'s exports
(per the plugin reference doc); confirm by reading
`plugins/tasks-core/server/index.ts` — if it's there, import from there;
otherwise add it.

## Reused primitives

| Primitive | Source | Used for |
|---|---|---|
| `@dnd-kit/core` + `@dnd-kit/sortable` | already in workspace, see `tree-list.tsx:10` | Card reordering |
| `Popover` from `@base-ui/react/popover` | `web/src/components/ui/popover.tsx` | Form shell (unchanged) |
| `Button`, `buttonVariants` | `@/components/ui/button` | Model chip pills, footer buttons |
| `MdAdd`, `MdClose`, `MdDragIndicator` | `react-icons/md` | Iconography |
| `Shell.Toast` | `@plugins/shell/web` | Submit success / error toasts |
| `uploadAttachment` | `@plugins/infra/plugins/attachments/web` | Screenshot upload (unchanged) |
| `createTask`, `_taskAttachments` | `@plugins/tasks-core/server` | Task creation |
| `addTaskDependency` | `@plugins/tasks-core/server` | Chain edges |
| `armTaskAutoStart` | `@plugins/tasks/server` (new export) | Auto-launch logic |

## Files to modify / create

### New

- `plugins/improve/web/components/improve-card.tsx`
- `plugins/improve/web/components/chain-connector.tsx`
- `plugins/improve/web/components/model-chip.tsx`

### Edit

- `plugins/improve/web/components/improve-form.tsx` — host SortableContext,
  render cards, footer.
- `plugins/improve/web/components/improve-button.tsx` — switch state to
  `cards: Card[]`, single Submit handler that posts the chain.
- `plugins/improve/server/internal/handle-submit.ts` — loop over cards,
  chain dependencies, arm each card.
- `plugins/improve/shared/types.ts` — new request/response shape.
- `plugins/tasks/server/index.ts` — re-export `armTaskAutoStart` (and
  `addTaskDependency` if not already public).

### Unchanged but referenced

- `plugins/tasks/server/internal/arm-auto-start.ts` — `armTaskAutoStart`
  function (exported via the tasks barrel).
- `plugins/tasks-core/server/internal/mutations/tasks.ts` —
  `addTaskDependency`.
- `plugins/improve/server/internal/meta-improvements.ts` —
  `IMPROVEMENTS_META_TASK_ID`.
- `plugins/improve/server/internal/render-prompt.ts` — only used now via the
  `tasks.maybe-launch` job path; head card description still uses
  `renderTaskDescription` for the markdown body.

## Verification

After `./equin build`:

1. **Single-task regression.** Open `+improve`, type one line, click Submit
   with chip on Sonnet. Confirm a single task lands under "Improvements" and
   a conversation auto-launches. URL/Screenshot toggles still work.
2. **Two-card chain, both armed.**
   - Card 1: "Design status-chip pattern", chip `Sonnet`.
   - Card 2: "Apply chip to conv-list sidebar", chip `Opus`.
   - Submit. Verify in `/tasks` (or task-graph): two tasks, edge from card 1 →
     card 2, only card 1's conversation has launched. Mark card 1 done; card 2
     should auto-launch with Opus shortly after (the `tasks.maybe-launch`
     trigger fires).
3. **Mid-chain Queue.** Card 1 `Sonnet`, Card 2 `Queue`, Card 3 `Opus`.
   After card 1 completes, card 2 must NOT auto-launch (it's queued, no model
   set). Manually mark card 2 done — card 3 should then auto-launch.
4. **Reorder.** Add three cards, drag the bottom one to top, submit. Verify
   chain edges follow the new order.
5. **Insert prereq.** Type into card 1; click the `+` connector above card 1
   to insert a new empty card 0; type a prereq; submit. Verify the new card 0
   has no blockers and card 1 is now blocked by it.
6. **Empty card guard.** Add a 2nd card, leave it blank → Submit must be
   disabled. Type into it → enabled.
7. **Cycle / cascade safety.** Submit a chain of 5 cards rapidly; confirm no
   orphan tasks if any single create fails (today's all-or-nothing guard via
   pre-validating attachments still holds; loop should also fail-fast and
   report which card index broke).
8. **e2e.** Use `bun e2e/screenshot.mjs` to capture before/after of the
   popover at 1, 2, and 3 cards to spot-check layout doesn't overflow the
   480px width.

## Out of scope (deferred)

- Per-card URL / Screenshot context (v1 attaches both to head only).
- DAG dependencies (cards depend on arbitrary earlier cards). The strict
  linear model maps to 95% of cases.
- Persisting unsent drafts across popover open/close. Today the form discards
  on Cancel; same applies here.
- Showing a mini-graph preview using `task-graph`'s xyflow component. Cute
  but not essential — the linear card order already conveys the chain.
