# Escape never enters block-selection mode — root cause and fix

## Context

In the page editor, pressing **Escape** while the caret is inside a block's text
editor is meant to leave text editing and select that whole block.
`keyboard-plugin.tsx` registers `KEY_ESCAPE_COMMAND → SelectionControl.enterSelectionMode`,
which applies the range and focuses the selection container. It does not work: the
selection bar stays at "0 selected", no row highlights, and polling shows it is not
a flash-then-clear — the range never lands visibly at all.

Consequence: the documented primary way into block-selection mode is dead, which
also hides the multi-block Tab / Shift+Tab indent affordance that landed recently.

## Root cause (confirmed empirically, not inferred)

`SelectionLayer`'s container (`block-editor.tsx:474`) guards its keyboard handler with

```ts
const onKeyDown = useCallback((e) => {
  if (document.activeElement !== containerRef.current) return;
  if (!isActive) return;
  ...
  if (e.key === "Escape") { e.preventDefault(); clearSelection(); return; }
```

`document.activeElement` is a **mutable global sampled after the fact**, so this is a
time-of-check/time-of-use bug. The exact sequence for one Escape keypress:

1. Lexical's native keydown listener on the block's `contenteditable` fires first and
   dispatches `KEY_ESCAPE_COMMAND`. Our handler calls
   `enterSelectionMode(blockId)` → `applyRange(id, id)` (a `useReducer` dispatch,
   still pending) → `focusContainer()` → `containerRef.current.focus()`.
2. `.focus()` synchronously fires `focusin`. `focusin` is a **discrete** event, so
   React flushes the pending reducer update before dispatching it. The container
   re-renders with `isActive === true` and a fresh `onKeyDown` closure.
   (`onFocusCapture` correctly discriminates on `e.target`, so it does *not* clear.)
3. The **same keydown is still bubbling.** It reaches React's delegated root listener,
   which walks the fiber path and calls the container's *current* `onKeyDown` prop —
   the fresh closure. `document.activeElement` is now the container (step 1 moved it)
   and `isActive` is now `true`, so both guards pass and the handler takes its
   `Escape → clearSelection()` branch, wiping the selection that Escape just created.

Nothing else clears it; the container's own `onFocusCapture` guard holds. Shift+click
and marquee work because no keystroke is involved.

**Proof.** Against a live build, installing a bubble-phase `keydown` listener on the
container that `stopPropagation()`s Escape (so the event can never reach React's root
listener, hence the container's React `onKeyDown` cannot run):

```
BASELINE  bar: 0 selected   activeElement: listbox
STOPPROP  bar: 1 selected   highlightedRows: 1   activeElement: listbox
```

### Same root cause, second victim

`resolveKeystroke` also emits `selectBlock` for **Shift+Arrow at a visual edge**
(`internal/keystroke-intent.ts:145,151`), which calls `enterSelectionMode(id, "up"|"down")`.
The same double-handling makes the container's `ArrowUp` + `shiftKey` branch extend the
range a *second* time off the same keydown. Measured on a 4-block page, caret at the
start of block 3, Shift+ArrowUp:

```
Shift+ArrowUp at first line -> bar: 3 selected   (expected: 2 selected)
```

This over-selection was never reported but is the same defect. One fix cures both.

## The fix

**Discriminate on the event's own origin, not on a global sampled later.**
`e.target` records which element was focused *when the key was pressed* and is immune
to a focus move during the dispatch:

```ts
if (e.target !== containerRef.current) return;
```

This is not a new idea in this file — the sibling `onFocusCapture` handler
(`block-editor.tsx:944`) already uses exactly this discriminator. The keyboard handler
is the outlier.

Keep `document.activeElement` for the **clipboard** handlers (`onCopy`/`onCut`/`onPaste`).
They ask a genuinely different question — "does the container own the clipboard right
now?" — which *is* an `activeElement` question, and no handler moves focus during a
clipboard dispatch. Switching those to `e.target` would be a regression risk: a `copy`
event's target follows the DOM selection, which can still sit inside the block's text
node after Lexical blurs.

### Making the mistake unrepresentable

A one-line fix leaves the guard as ad-hoc code any future edit can get wrong again, and
the container's key handling is currently buried in a 1000-line component next to
marquee, DnD, file-drop and clipboard. So the fix lands with a small extraction that
gives the guard exactly one home:

**New: `plugins/page/plugins/editor/web/internal/use-block-selection.ts`** — the block
selection machine, moved verbatim out of `SelectionLayer`:

- owns `containerRef`, `anchorRef`, `headRef`
- `applyRange` / `clearSelection` / `focusContainer`
- the `SelectionControl` context value (`enterSelectionMode`, `extendTo`, `clear`)
- the container's `onKeyDown` (with the single origin guard) and `onFocusCapture`
  (the two handlers that encode focus-vs-selection policy, now co-located)

It takes `{ orderedIds, roots, actions }` where `actions` is the structural surface it
drives (`indent`, `outdent`, `remove`, `duplicate`, `focusBlock`, `moveSelection`) —
so the machine has no dependency on `useBlockEditor()`, the optimistic pipeline, live
state, or Lexical, and is directly mountable in jsdom.

`SelectionLayer` keeps everything else (marquee, dnd-kit, file drop, clipboard,
rendering) and consumes the hook.

**Dead code removed:** `SelectionControl.selectOnly` has no call sites anywhere in the
repo (`onEmptyClick` calls `applyRange` directly). Delete it from the interface and its
implementation rather than carry an untested third entry point.

## Files

| File | Change |
| --- | --- |
| `plugins/page/plugins/editor/web/internal/use-block-selection.ts` | **new** — the selection machine + the origin guard |
| `plugins/page/plugins/editor/web/components/block-editor.tsx` | consume the hook; drop the moved code |
| `plugins/page/plugins/editor/web/selection-control.tsx` | drop dead `selectOnly` |
| `plugins/page/plugins/editor/web/__tests__/block-selection.test.tsx` | **new** — jsdom coverage |
| `e2e/block-selection-verify.mjs` | **new** — real-browser verification |
| `plugins/page/plugins/editor/CLAUDE.md` | document the origin-guard invariant |

## Tests

### jsdom (`web/__tests__/block-selection.test.tsx`)

The repo has no `.test.tsx` for the editor yet; this establishes it. Mounting the real
`<BlockEditor>` is impractical (live-state, optimistic resource, Lexical, the whole
block registry), so the test mounts the **real** `useBlockSelection` + the **real**
`MultiSelectProvider`, and stands in a fake block editor: a `contenteditable` div with
a **native** `keydown` listener that calls `enterSelectionMode` — structurally identical
to what `KeyboardPlugin` does through Lexical (native listener on the contenteditable,
running before React's delegated root listener, calling `.focus()` mid-dispatch).
That reproduces the defect's mechanism exactly; only the structural actions are stubs.

**Finding: jsdom cannot reproduce the mid-dispatch flush.** React schedules the
sync-lane reducer update on a microtask, which cannot run while the synchronous
dispatch is still unwinding — so the container's stale closure bails at `!isActive`
before the bad guard does damage. A real browser re-renders in time (`focusin` is
discrete) and the guard fires. Dispatching outside `act()` does not help: it only
defers the render further. Verified by experiment, not assumed.

So the unit test reaches the same *state* across two keystrokes: once selection mode
is entered, `document.activeElement` IS the container and a selection IS live —
exactly the mid-dispatch state — and every subsequent block-targeted keystroke
discriminates the guards. Cases:

1. **Escape in another block re-selects it instead of clearing.** *(RED before the fix)*
2. **Shift+ArrowUp at a block edge extends by exactly one** — 2 selected, not 3. *(RED)*
3. **Keys targeted at a block editor never reach the container handler.** *(RED)*
4. Escape on the focused container clears; focusing a block drops the selection.
5. Arrow / Shift+Arrow / Alt+Shift+Arrow / Tab / Backspace / Enter / Cmd+A / Cmd+D
   in selection mode still reach their actions.

Red-before-green was enforced as a hard gate: with the old `activeElement` guard the
suite fails 3 tests; with the fix all 22 pass. The single-dispatch symptom (a fresh
Escape with no prior selection) is covered by the e2e script below.

Run: `bun run test:dom plugins/page/plugins/editor`

### e2e (`e2e/block-selection-verify.mjs`)

Follows the existing `e2e/*.mjs` convention. Creates a blank page, types four blocks,
then asserts, in a real browser (all 9 checks passing after the fix):

- Escape in a block → `1 selected`, one highlighted row, container focused
- Escape again → `0 selected`, no highlighted row
- Shift+ArrowUp at the first line of block 3 → `2 selected`
- Tab in selection mode indents by exactly `BLOCK_INDENT` and the selection survives;
  Shift+Tab restores it (the affordance this bug was hiding)

The first and third already measured failing on the unfixed build (`0 selected`,
`3 selected`). Note a block's depth is rendered as the ROW's left padding, so the
indent must be measured on the contenteditable's left edge, not the row's.

Run: `bun e2e/block-selection-verify.mjs --base http://<worktree>.localhost:9000`

## Verification

1. `./equin build`
2. `bun run test:dom plugins/page/plugins/editor` — jsdom suite green
3. `bun e2e/block-selection-verify.mjs --base http://att-1783672287-e6qz.localhost:9000`
4. `./equin check` — boundaries, type-check, lint, doc sync

## Deliberately not done

- **No ESLint rule banning `document.activeElement` comparisons.** A repo-wide sweep
  found 10 occurrences in 7 files; only the 4 in `block-editor.tsx` are event-ownership
  tests, and 3 of those (the clipboard trio) are *correct* and must stay. The remaining
  6 are `useEffect`/`useState`/update-listener focus-sync guards that never run inside
  a live event dispatch. A rule would need an ignore list longer than its hit list.
  Confining the one genuine event-ownership guard to a single tested hook is the
  proportionate structural fix.
- **No `stopPropagation()` in `keyboard-plugin.tsx`.** Suppressing propagation to fix an
  outer handler's bad guard papers over the guard and would silently starve any other
  legitimate listener (e.g. the window-level shortcut manager) of those keystrokes.
