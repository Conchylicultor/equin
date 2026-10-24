# Dragging a multi-block selection must reach `bulkMove`

## Context

In the page editor, selecting several blocks and dragging them by the gutter
handle moves only ONE block. The bulk path is correct and complete — it is
simply unreachable in a real browser.

Measured (recorded in `e2e/drag-reorder-verify.ts`'s header): selection count is
2, still 2 on hover over the drag handle, and **0 on mouse-down** — before
dnd-kit fires `onDragStart`. The gesture therefore starts from an empty
selection and resolves as an ordinary single-block drag.

The mechanism is three facts, each individually correct:

1. The gutter drag handle is a `<button>` (`web/components/block-rail.tsx:101`).
   Pressing a button focuses it.
2. Block-selection mode is **focus-scoped**: the block-list container is the
   keyboard and clipboard target while no block editor holds the caret, and the
   selection is dropped the moment focus lands anywhere else
   (`web/internal/use-block-selection.ts:172-176`). That guard is load-bearing —
   it is what reads an `@lexical/yjs` untagged-reconcile `rootElement.focus()`
   as "the user went back to typing", the hazard `releaseCaret` and
   `research/2026-07-17-page-block-selection-focus-steal.md` exist for.
3. dnd-kit's `PointerSensor` has `activationConstraint: { distance: 4 }`
   (`web/components/block-editor.tsx:928`), so `onDragStart` runs only *after*
   the mousedown that already cleared the selection.

Consequence: `onDragStart`'s `selectedIds.has(id)` is never true, `onDragEnd`
never takes its `if (bulk)` arm, and `bulkMove` has exactly one live caller
(Alt+Shift+Arrow). A user reordering a multi-block selection loses the rest of
their selection with no feedback.

**Intended outcome.** Dragging a multi-selection by any selected block's handle
moves the whole run as one rigid body — one op, one undo entry, one optimistic
overlay — using the `bulkMove` machinery that is already written and already
correct downstream.

## The resolution: neither documented rule yields; the rail stops taking focus

> The gutter rail ACTS ON a block. It never takes the keyboard away from the
> surface that owns block-selection mode.

Both rules above stay exactly as written. `onFocusCapture` is untouched, so
block-selection mode remains focus-scoped and the *visible* selection can never
disagree with the *live* keyboard (the `onKeyDown` origin guard requires
`e.target === container`, so a selection that survives a focus move to a button
would be highlighted but keyboard-inert — a worse, quieter failure than the one
being fixed).

The rail's controls simply never move focus onto themselves. Suppressing the
`mousedown` default is the existing idiom in this tree — `block-row.tsx:158-172`
already does it for Shift+click ("mousedown + preventDefault stops the text
selection / focus that a click would otherwise start"), and
`primitives/tree/web/internal/tree-row-chrome.tsx` does the pointer-level twin
for the same reason.

This is safe against dnd-kit: `PointerSensor` activates off `pointerdown`, which
fires before `mousedown` and is untouched. It is safe against the block-actions
popover: Base UI's `PopoverTrigger` opens on click, and its close-autofocus
restores focus by an explicit `.focus()` call, neither of which depends on the
press's default action.

## Changes

### 1. `web/components/block-rail.tsx` — one `RailButton`, one rule

Introduce a file-local `RailButton` that every gutter control routes through
(chevron, `+`, drag handle). It owns:

- `onMouseDown={(e) => e.preventDefault()}` — the rule above, stated once.
- the shared positioning/appearance classes and the single
  `eslint-disable-next-line layout/no-adhoc-layout` comment that is currently
  triplicated verbatim across the three buttons;
- `style={{ left }}` from a `left` prop, and `ref` + rest-props forwarding so
  the drag handle can still carry `ref={setDragRef}`, `{...attributes}` and
  `{...listeners}` from `useDraggable`.

The per-control differences stay at the call sites: the chevron's pinned-while-
collapsed opacity, each control's `aria-label` / `onClick`, and the drag
handle's `cursor-grab`.

This is the structural closure at the right scale. `block-rail.tsx` is already
the single declaration site for the rail — its docblock states "It takes
`{ seat }` and nothing else, and that is the point" — so making `RailButton` the
only `<button>` in the file means a future rail control cannot reintroduce the
focus steal without deliberately writing a raw `<button>` next to it. A lint
rule is deliberately **not** proposed: the surface is one 120-line file, not an
open set. Record the rule in the file docblock so the next reader knows why the
`preventDefault` is there.

### 2. `web/components/block-editor.tsx` — `onDragStart`'s non-bulk arm must clear

Once the press no longer clears the selection, dragging a block that is **not**
in a live selection would leave that selection highlighted over blocks the
gesture never touched. The clear was previously a side effect of the focus
steal; it now has to be said:

```ts
if (id && selectedIds.has(id)) {
  ...setBulkDragState({ roots, subtree });
} else {
  setBulkDragState(null);
  clearSelection();   // dragging outside the selection ends it (Notion's model)
}
```

`clearSelection` is already destructured from `useBlockSelection` in this
component (line 477).

Nothing else in the DnD path changes. `currentTarget()`, the bulk before/after
`afterId` computation, the bulk-subtree row highlighting, the `"N blocks"`
`DragOverlay`, `planBulkMove`'s refusals (including the loud cross-page refusal)
and the single-undo-entry recording are all already written for this path and
become reachable as-is.

### 3. `plugins/page/plugins/editor/CLAUDE.md`

Add the rule to the existing **"Block-selection mode: the container handles only
keys it originated"** section, beside the two invariants already stated there:

> **The rail never takes the keyboard.** Block-selection mode is focus-scoped —
> `onFocusCapture` ends it the moment focus leaves the container, which is what
> keeps the highlighted selection and the live keyboard in agreement (`onKeyDown`
> answers only to `e.target === container`). A gutter control ACTS ON a block, so
> it must not become that focus target: every control in `block-rail.tsx` goes
> through `RailButton`, which suppresses the press's default. Without it,
> mousedown on the drag handle cleared the selection before dnd-kit's 4px
> activation distance was travelled, and every multi-block drag silently degraded
> to a single-block `move`.

### 4. `e2e/drag-reorder-verify.ts` + `e2e/support/block-selection.ts`

- Delete the `PRE-EXISTING DEFECT` paragraph from the header and add the new
  phase to the phase list.
- Export `selectedCount()` from `support/block-selection.ts` (it exists there
  already, private) via `BlockSelectionDriver`, so a script can assert the live
  "N selected" count mid-gesture. That count is the *direct* measurement of the
  regression, not a proxy for it.
- Give `dragRow` an optional `afterGrab?: () => Promise<void>` hook invoked
  between `mouse.down()` and the first move, so the assertion lands inside the
  gesture.
- Add **phase E** (appended, on its own fresh `openBlankPage` so its expected
  order is independent of A–D, and after D's `page.reload()`): drag a
  two-block selection.
  - `enterBlockSelection` + `Shift+ArrowDown`; assert count is 2.
  - press the handle; **assert count is still 2** — the regression, stated
    directly;
  - drop below a later block; assert DOM order and `serverTexts()` both show the
    run moved as a rigid body with its internal order intact;
  - assert exactly ONE op POST for the whole gesture;
  - assert the selection survives the drop (count still 2) and
    `checkSelectionOwnsFocus` still holds — the container never lost focus, which
    is the fix restated as an observable;
  - one `Meta+z` reverses the whole multi-block move.

Phase B (Alt+Shift+Arrow) stays: it is the keyboard spec for the same op, and
the two entry points are worth pinning separately.

No jsdom test is added. The fix is in the rail, not the hook, and what it
changes — whether a real browser moves focus on a real mousedown before dnd-kit's
activation distance — is precisely what jsdom cannot model. Same call the caret
authority already documents: timing-of-a-real-commit questions belong in the e2e.

## Critical files

- `plugins/page/plugins/editor/web/components/block-rail.tsx` (the fix)
- `plugins/page/plugins/editor/web/components/block-editor.tsx` (`onDragStart`)
- `plugins/page/plugins/editor/web/internal/use-block-selection.ts` (**unchanged** — read it to confirm the guard stays as documented)
- `plugins/page/plugins/editor/CLAUDE.md`
- `plugins/page/plugins/editor/e2e/drag-reorder-verify.ts`
- `plugins/page/plugins/editor/e2e/support/block-selection.ts`

## Risks to check during implementation

- **Base UI prop merging.** The drag handle is passed as `trigger` into
  `BlockActionsMenu` → `<PopoverTrigger render={trigger} />`
  (`primitives/popover/web/internal/inline-popover.tsx:45`). Confirm the merged
  element still carries our `onMouseDown` and that a plain click still opens the
  menu. If Base UI's own handler wins, move the `preventDefault` to
  `onMouseDownCapture` — the exact form `block-row.tsx` already uses.
- **dnd-kit activation.** Preventing the `mousedown` default must not stop the
  drag. Phase A of the e2e (single-block drag) is the existing regression net.
- **Focus ring.** The handle no longer takes focus on click; it still takes it
  on Tab, so keyboard access to the actions menu is unchanged.

## Verification

```bash
./equin build
bun plugins/page/plugins/editor/e2e/drag-reorder-verify.ts
```

Regression-check the other scripts that drive the same handle, since they use it
for both dragging and opening the actions menu:

```bash
bun plugins/page/plugins/editor/e2e/block-selection-verify.ts
bun plugins/page/plugins/editor/e2e/drag-autoscroll-verify.ts
bun plugins/page/plugins/container/e2e/container-rail-verify.ts
bun plugins/page/plugins/callout/e2e/callout-container-verify.ts
```

Then the repo gates:

```bash
./equin check
bun run test:dom plugins/page/plugins/editor
bun test plugins/page/plugins/editor/core
```

**Manual, at `http://att-1785761950-h77k.localhost:9000` → Pages** (the "N
selected" count in the selection bar is the tell — watch it, not the drag
result):

1. New page with `alpha` / `bravo` / `charlie` / `delta`.
2. Click into **bravo**, wait ~500ms (outlast the unrelated async focus steal,
   `task-1784221574192-phh891`), press **Escape** → "1 selected".
3. **Shift+ArrowDown** → "2 selected".
4. Hover the bravo row, then press and hold the ⠿ handle without moving.
   → the count must stay at **2** (today it drops to 0).
5. Drag below delta and release → **bravo and charlie both moved**, in order,
   and the selection is still live at "2 selected".
6. **Cmd+Z** once puts both back.
7. Counter-case: with those two selected, drag **delta**'s handle instead — it
   moves alone and the selection clears.
