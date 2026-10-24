# Improve popover — rebuild around the composer

## Context

The Improve popover (`plugins/tasks/plugins/task-draft-form`, also used by the
conversation `+`, and by "Add prerequisite" / "Add follow-up" on the task detail)
was redesigned in prototype **proto-1789665568-9onf**. The prose box inside it is
**already shipped**: `TaskDraftComposer` is the real implementation of
proto-1789901373-oy29, exhibited as the specimen `component:task-draft/composer`.

This change **keeps that composer unchanged** and rebuilds the popover around it
to match the mock. Most of the behaviour already exists (drag to reorder, the
parallel / sequential toggle, insert-here, per-card launch options); what changes
is how the chain chrome looks and where each control lives.

Decisions taken with the user:

- **After submit: keep today's toast + close.** The mock's "Task filed" screen is
  not built.
- **Mode extras move into the Dependency menu.** The follow-up "Insert before
  ⟨child⟩" and the prerequisite "Standalone" checkboxes leave the space under
  the head card.
- **Remove (×) lives on the connector**, removing the task below it. The first
  task has no connector: the **header's ×** covers it — with 2+ tasks it removes
  the first task (the next one becomes first), with one task left it closes the
  popover.

Out of scope: the composer's own layout (text box, attach row, pills), the mock's
screenshot attach button, the submit endpoint and its toast, the per-app theme.

## What changes, by surface

### 1. Header — `task-draft-form.tsx`

Today it shows a muted caption (`heading ?? "Draft tasks"`) with no way to close
from inside the popover. It becomes a title row: `heading` as the popover's title
(semibold body text, not caption) + an `IconButton` (`MdClose`) on the right
whose action depends on the chain:

- **2+ tasks → removes the first task** (`removeAt(0)`). The second task becomes
  the head, and the head-only controls move to it: the attach row, the Dependency
  pill, and the host's insert funnel. Its own text and launch options are kept.
  The label and tooltip read **"Remove task 1"**.
- **1 task → closes the popover** (`onCancel`; the draft stays persisted, as
  Cancel does today). The label and tooltip read **"Close"**.

The label changes with the action, so a hover always says which one a click
will do. `removeAt` already refuses to drop the last card, so the two branches
cannot overlap. The agent-worktree "Experimental"
banner stays, above the title row. Callers' `heading` strings are unchanged
("Improve this app", "Create child task", "Add prerequisite", "Add follow-up").

### 2. Card — `task-draft-card.tsx`

- **Drag only from a grip.** Today the whole card is the dnd-kit drag host
  (`{...attributes} {...listeners}` on the outer `Stack`, `cursor-grab`, plus a
  `stopPropagation` wrapper around the composer so typing doesn't drag). Replace
  that with an explicit grip button pinned top-right: `useSortable`'s
  `setActivatorNodeRef` + `listeners` + `attributes` go on the grip only
  (`MdDragIndicator`, label "Drag to reorder"). The outer `Stack` keeps
  `setNodeRef` / `transform` for the moving box. The `stopPropagation` wrapper
  and the card-level grab cursor are deleted.
- The grip renders **only when there are 2+ cards** (new prop `movable`),
  always visible at reduced opacity and full on card hover. Today's version is
  hover-revealed at 30% opacity, which reads as "there is no handle".
- The card's **× is removed** (it moves to the connector, §4) along with
  `removable` / `onRemove`.
- `InsertBeforeChildren` and the standalone checkbox are **no longer rendered
  here** (§3). The card threads them into the composer's `relate` instead.

### 3. Mode extras inside the Dependency menu

- **Primitive: `PickerPill.Check`** in
  `plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill`.
  It is a checkbox row built on ui-kit's existing `DropdownMenuCheckboxItem`
  (`checked`, `onCheckedChange`, `disabled`, children). It calls
  `e.preventDefault()` in `onSelect`, so ticking a box does **not** close the
  menu. `partition()` already accepts any element inside a `Group`, so no change
  is needed there. Update that plugin's CLAUDE.md with one line: "a `Check` row
  toggles without closing".
- **`dependency-pill.tsx`** gains an optional `extras` prop:
  ```ts
  extras?: {
    insertBefore?: { children: ChildEntry[]; selected: Set<string>; onChange(next: Set<string>): void };
    standalone?: { checked: boolean; onChange(next: boolean): void };
  }
  ```
  - Follow-up with children → a second group **"Insert before"** with one
    `Check` per child (title truncated), defaulting to all checked. This is
    today's semantics, still owned by the keyed `InsertBeforeForm`.
  - Prerequisite on a task that has deps → a second group **"Options"** with one
    `Check`: "Standalone — don't inherit existing dependencies".
- **`task-draft-composer.tsx`**: the `relate` prop's type gains the same
  optional `extras` and forwards it to `DependencyPill`. This is the only edit to
  the composer, and it is pure passthrough, so the specimen is unaffected.
- **Delete `insert-before-children.tsx`.** Move its `ChildEntry` type into
  `dependency-pill.tsx`. The "Select all / None" link goes away: with the default
  already being all, one check per child is enough.

### 4. Connector — `chain-connector.tsx` (rewrite)

Today it is a 12px-tall mark ("↓ BLOCKS" / "∥ PARALLEL") whose buttons appear
only on hover, and insert is offered only while linked. It becomes a labelled
row:

- Linked: `↓ Then, once task {n} is done` followed by a solid hairline.
- Unlinked: `∥ In parallel — doesn't wait for task {n}` followed by a dashed
  hairline.
- Three always-visible `IconButton`s on the right:
  - link / unlink (`MdLinkOff` ↔ `MdLink`, with the existing aria labels)
  - **Insert a task here** (`MdAdd`), offered in **both** states
  - **Remove task {n+1}** (`MdClose`)

Together with the header's × (§1), every task in the chain has exactly one ×.

New props: `prevNumber` (the 1-based number of the task above) and `onRemove`.
`task-draft-form.tsx` passes `removeAt(idx)` and `idx`.

### 5. Footer — `task-draft-form.tsx`

- The separate `+ task` row goes away. **`+ Follow-up task`** becomes a ghost
  button on the footer's left.
- Submit reads **`Create task` / `Create N tasks`**, followed by a `Kbd` "⌘↵"
  (from `@plugins/primitives/plugins/overlay/plugins/tooltip/web`). ⌘↵ already
  submits through the composer's `onSubmitChord`. Cancel stays.
- The `border-t` divider above the footer is dropped, per the mock.
- `footerStart` has no callers (checked). Delete the prop from
  `TaskDraftPopoverProps` and `TaskDraftFormProps`.

### 6. Keyboard reordering — `task-draft-form.tsx`

Add dnd-kit's `KeyboardSensor` with `sortableKeyboardCoordinates` next to the
existing `PointerSensor`. A focused grip then moves with Space + ↑/↓ — the
standard dnd-kit gesture, which replaces the mock's bare ↑/↓.

## Files

- `plugins/tasks/plugins/task-draft-form/web/components/task-draft-form.tsx` —
  header, footer, sensors, connector wiring
- `…/task-draft-card.tsx` — grip-only drag, drop the × and the extras
- `…/chain-connector.tsx` — rewrite
- `…/dependency-pill.tsx` — `extras` groups, `ChildEntry` moves here
- `…/task-draft-composer.tsx` — `relate.extras` passthrough only
- `…/insert-before-children.tsx` — deleted
- `…/task-draft-popover.tsx` — drop `footerStart`, pass the extras through
- `plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web/components/picker-pill.tsx`
  (+ its `web/index.ts` type export, CLAUDE.md) — `PickerPill.Check`
- `plugins/tasks/plugins/task-draft-form/CLAUDE.md` — replace the "Card vs
  composer" description of the card chrome (grip, connector owns remove, extras
  in the Dependency menu)
- `plugins/tasks/plugins/task-draft-form/e2e/card-actions-verify.ts` — extend
  (see Verification)

Reused as-is: `ChainConnector`'s link state (`CardDraft.linkedToPrev`),
`insertAt` / `toggleLink` / `removeAt` / dnd-kit `arrayMove` in
`task-draft-form.tsx`, `IconButton`, the `Kbd` primitive, and ui-kit's
`DropdownMenuCheckboxItem`.

## Verification

1. `./equin build` (backgrounded), then confirm `build-status.json`
   reports `status: ok`.
2. Screenshots of the real popover next to the mock: `screenshot.ts --path /tasks
   --click "Improve"`, plus a two-task chain.
3. Extend `card-actions-verify.ts`, which drives the "+ Prerequisite" popover:
   - add two follow-ups → each card has a grip; the head card has no connector
   - "Insert a task here" on connector 1 → a card appears at index 1
   - unlink connector 2 → it reads "In parallel — doesn't wait for task 2"
   - Remove on connector 1 → 2 cards remain
   - header × with 2 cards → it is labelled "Remove task 1", the first card goes
     and the old second card now carries the attach row / Dependency pill; header
     × again with 1 card → labelled "Close", the popover closes
   - keyboard: focus grip 2, Space ↑ Space → order swaps
   - open Dependency, pick "As prerequisite" → the "Options" group shows; tick
     Standalone → the menu stays open and the box is checked
   - the existing assertion (every card carries the element-picker action) still
     passes
4. File a real chain from the popover with one link toggled off. Confirm in the
   task list (or with `query_db` on `task_dependencies`) that the unlinked task
   has no edge to the task above it, and the linked one does.
5. `./equin check`.
