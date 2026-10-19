# caret-trigger

A caret-anchored **trigger menu** primitive for Lexical editors — the shared
substrate behind the page editor's `/` (slash), `[[` (page-link), `@` (date),
and `$$` (inline-math) menus. Type a trigger string mid-line and a floating
surface opens at the caret; the text after the trigger is the live query.

## Why this exists — open-state is DERIVED, never latched

Every one of those four menus was originally a hand-rolled copy of the same
`registerUpdateListener` loop, each carrying a mutable `dismissedRef` boolean
latch set on Esc / outside-press and *cleared* across several early-return
branches of the listener. The obligation to clear the latch on every "no
trigger" path is unwritten and easy to miss: an empty Lexical block has **no
TextNode** (the selection anchor is the ParagraphNode), so the branch that
cleared the latch when the `/` disappeared was unreachable exactly when the
block was empty — the menu wedged permanently closed for that block. Four
copies, three different reset-branch counts: one bug, patched independently
four times.

The fix is to stop treating open-state as a latch mutated across N branches and
make it a **pure derivation of the editor**:

```
open = trigger !== null && dismissedId !== triggerId(trigger) && focused && isCaretOwner
```

`reduceTriggerState` is the single place `dismissedId` is ever cleared: the
`trigger === null` transition (no selection, non-collapsed, not a text node, no
trigger, boundary fail, invalid query — *all* collapse to one `null`) clears it.
No branch can forget, because there are no branches — the empty block is just
"no trigger", the same state as "never typed one".

## Two calls, not one — the `query → items → menu` flow is one-way

The primitive is deliberately **two hooks**, called in order:

```ts
const caret = useCaretQuery({ id, trigger, canOpen?, isQueryValid? });
const items = /* consumer computes items FROM caret.query */;
const { surfaceOpen, activeIndex, setActiveIndex } = useCaretMenu(caret, {
  itemCount: items.length,
  onCommit: (i) => commit(items[i]!),
});
```

- `useCaretQuery` derives the trigger from the editor alone — it depends on
  **nothing** the consumer computes. It owns the update listener
  (`findTrigger` + `reduceTriggerState`), the arbiter candidacy, the `focused`
  dimension, `dismiss()`, and the `activeIndex` **state** (reset to 0 *inside*
  the update listener on every query change — co-located with the state write,
  not a render effect, so the highlight starts at the top with no flash).
- `useCaretMenu` consumes that handle **plus** the item count the consumer
  derived from `caret.query`. It owns the `open`/`interactive`/`surfaceOpen`
  derivation, the `activeIndex` clamp + wrap-around `move()`, and the three
  keyboard gates.

**Why two.** Every consumer derives its item count from the OUTPUT `query`
(page-link fetches page options for the query; date builds a menu; math has one
item iff the query is non-empty; slash filters block types). A single hook that
took `itemCount` as an input forced every consumer into a render-phase feedback
loop — `const [itemCount, setItemCount] = useState(0)` fed back in from a value
computed off `query`, with `if (n !== itemCount) setItemCount(n)` during render.
That is the exact class of latent-coupling defect this primitive exists to
delete, duplicated once per consumer. Splitting the seam makes the dependency
`query → items → menu` flow one way and enforced by call order: there is no
cycle and no render-phase `setState`, so the workaround is unrepresentable.

`CaretQuery` is a stable-enough handle (`editor`, `dismiss`, `setActiveIndex`
are stable identities) that `useCaretMenu`'s command effects register once and
read fresh state through refs — `query` never lands on an effect dep array that
would re-register Lexical commands on every keystroke.

## The forced producer — a button-driven `CaretQuery`

`useForcedCaretQuery` is the second producer of the SAME `CaretQuery` handle, so
`useCaretMenu` + `CaretTriggerMenu` consume it identically. The difference is
where open-state comes from:

- Open-state is driven by an EXTERNAL `active` flag (a button set it), not by a
  trigger char: `open = active && focused && isQueryValid(query)`.
- The query is the FULL text before the caret (not the text after a trigger), so
  the current block's own text filters the menu inline.
- It does NOT participate in the single-owner arbiter — the `active` flag is
  externally single-owner by construction, so there is no candidacy to resolve.
- **`activeIndex` resets on the CLOSE edge**, not on a query change. This is the
  one place the two producers genuinely cannot share a rule. In the trigger-char
  flow, typing is what opens the menu, so a fresh open always brings a fresh
  query and the query-change reset in `sync` covers it. The forced flow breaks
  that coupling: `url-paste` force-opens with the caret just past the link it
  inserted, so its query is `""` on *every* open and the query-change reset never fires — dismiss with row 3
  highlighted, paste again, and the menu reopens on row 3 with Enter committing
  it. Resetting on close rather than on open is what keeps it flash-free: while
  `active` is false the surface is unmounted, so the write lands with nothing
  rendered, whereas an open-edge reset paints one frame of the stale highlight
  first. (Hoisting it into render would be the render-phase `setState` this
  primitive exists to delete.)

This is the substrate for any menu whose open signal is not a trigger char:

- The page editor's gutter `+` — inserts an empty paragraph below, focuses it,
  flags it `active`, and lets its block force-open the same menu the `/` trigger
  opens. Same surface, same keyboard model, one filtered list.
- `page/url-paste`'s Keep as link / Mention / Bookmark / Embed menu — the PASTE
  event sets `active`; its items are fixed, not filtered.

Both are the reason the forced producer exists rather than each menu going its
own way. `url-paste` originally did go its own way: it imported `caretAnchor`
and hand-rolled a `FloatingSurface` of `<Row onClick>`s, which rendered in the
right place but had no `activeIndex`, no arrows and no Enter — a mouse-only
menu, plus a duplicate `KEY_ESCAPE_COMMAND`. **A non-trigger-char open signal is
not a reason to leave the primitive**; it is the `useForcedCaretQuery` case.
`no-adhoc-caret-trigger` now enforces that: importing `CaretTriggerMenu` **or
`FloatingSurface`** without calling `useCaretMenu` is an error. `caretAnchor` is
plugin-private now — a thin live-anchor adapter over `selectionRect()` from
`@plugins/primitives/plugins/dom/plugins/dom-selection/web`, which owns the guarded read — so
it is not importable at all. Aiming the rule at the panel rather than at the
anchor helper is strictly stronger: `FloatingSurface`'s only production consumer
is `CaretTriggerMenu`, so the rule now catches a hand-rolled caret menu *however
it obtained its anchor* — including one anchored to an element rect, which never
touched `caretAnchor` and used to slip through.

## The three gates (they are genuinely distinct)

A single gate would be wrong in both directions, so the hook registers three:

- **Arrows + Enter** gate on `interactive` (`open && itemCount > 0`) — there
  must be something to commit. Arrows are registered *only* when `navigate !==
  false`; `$$` passes `navigate: false` so arrows still move the caret through
  LaTeX. A consumed arrow also `preventDefault`s: returning `true` stops only
  Lexical's listeners, so the browser would still move the caret, change the
  query, and reset the highlight the arrow just moved (url-paste's caret sits
  past a link and slides into it; `/`'s is already at the line end, which hid it).
- **Esc** gates on `surfaceOpen` — the exact boolean driving the surface's
  visibility. `[[`'s loading spinner and `@`'s "keep typing" hint are visible
  with zero items, and Esc must dismiss them; but Esc must *not* be swallowed
  when a no-match `/zzzz` query shows nothing.
- **Blur** flips the `focused` dimension and **never latches** (`return false`,
  non-consuming) — returning to a block whose text still holds the trigger
  re-derives `open` correctly.

## Committing an item — always through `useCaretMenu`'s `commit`, never a raw `onMouseDown`

Keyboard and mouse must be the SAME commit. Enter goes through
`KEY_ENTER_COMMAND → onCommit(activeIndex)`; a menu item click must go through
`commit(index)` on **`onPointerDown`**. A menu that instead wires its rows to
`onMouseDown={() => onSelect(x)}` (reading the live selection) is broken on
mouse in two independent ways, and both are why this seam exists:

1. **The row unmounts before its `mousedown`.** The surface is *focus-less* and
   portaled, so a press on it does not blur the editor — but it **extends the
   host's DOM selection** into the menu text (anchor left at the caret, focus
   into the row). A menu whose `open` is DERIVED from that selection (`/`, `[[`,
   `@`) therefore sees a non-collapsed selection → `trigger === null` → closes,
   and React unmounts the pressed row **between `pointerdown` and `mousedown`**.
   The `mousedown` (and any `preventDefault` on it) never runs. `pointerdown`
   fires while the row is still mounted and the caret still collapsed — so
   `commit` reads a valid trigger.
   *This perturbation is not a cancelable default:* `preventDefault` on
   `pointerdown`/`mousedown` (any phase) does NOT stop it, and `user-select:none`
   on the surface does NOT stop it. Committing early — before the perturbation —
   is the only fix.
2. **A raw handler runs `onCommit` outside a Lexical update.** The keyboard
   commit fires from inside `KEY_ENTER_COMMAND`, i.e. already within an
   `editor.update()`, so any nested `editor.update()` the consumer performs is
   **deferred**. A consumer that strips its `trigger…query` span in a nested
   update and then does a *store-level* write (the slash menu: strip the
   `/query`, then `convertTo` the block) relies on that deferral: the store
   write must land first. Run the same `onCommit` from a plain DOM handler and
   the nested update runs *synchronously first*, in the wrong order — the commit
   silently no-ops. `commit` wraps `onCommit` in `editor.update()`, so a pointer
   commit is byte-for-byte the keyboard commit.

`commit` therefore lives in `useCaretMenu` (one place, both hazards handled) and
every consumer routes item clicks through it (`page/editor`'s `BlockTypeList` /
`PageOptionsList` take an `onCommit`; `inline-date` calls `commit(i)` directly).
`e2e/caret-trigger-wedge.ts` covers the keyboard/derivation half; the
mouse-commit half is exercised by the page editor's click tests.

## The single-owner arbiter

Two triggers can be live in one node (`@friday [[bar|` — `chrono` parses
"friday" so `@` opens, and `[[` opens too). A module-level
`WeakMap<LexicalEditor, Arbiter>` — **not** a React Provider, because a provider
you must remember to mount is exactly the "you must also update X" coupling this
change deletes — resolves a single owner: the candidate whose trigger starts
**closest to the caret** (max `triggerIndex`). Losers derive `open = false`, so
at most one menu is ever open and Enter is unambiguous.

## Asymmetric failure is the whole point of `triggerId`

Identity is `nodeKey:triggerIndex` and **excludes the query**, so typing after
Esc stays dismissed. Lexical can invalidate that identity (a mark application
splits text nodes; inserting before the trigger shifts the index). That is safe
**by construction**: every identity mistake makes `dismissedId !==
triggerId(trigger)`, i.e. the menu *re-opens* — a benign spurious re-open, never
a wedge. A plain boolean latch would be immune to re-keying but retains a narrow
member of the original bug class (dismiss at `/foo`, click back to an earlier
`/bar`, stuck closed). We trade a harmless re-open for the elimination of every
wedge.

## Tests

Three layers, because the bug lived in state that neither tsc nor a pure test can
see:

```bash
bun test plugins/primitives/plugins/text-editor/plugins/caret-trigger/web/internal
bun run test:dom plugins/primitives/plugins/text-editor/plugins/caret-trigger
./singularity run plugins/primitives/plugins/text-editor/plugins/caret-trigger/e2e/caret-trigger-wedge.ts --origin http://<worktree>.localhost:9000
```

- **`web/internal/*.test.ts` (bun:test)** — the pure derivation: `scanTrigger`,
  `reduceTriggerState`, `triggerId`, `atWordBoundary`. Scope the path to
  `web/internal`; `bun test <plugin-dir>` would recurse into `web/__tests__/` and
  cross-load the vitest files.
- **`web/__tests__/wedge.test.tsx` (vitest/jsdom)** — the wedge itself, against a
  real `LexicalComposer`: dismiss → clear to a childless paragraph (no TextNode)
  → retype → `open` returns. It asserts the hook's derived `open`, not the
  rendered surface: the surface is caret-rect anchored and jsdom has no layout,
  so `FloatingSurface` would never paint. The derivation is where the bug lived.
  Note its `type()` helper appends to the **existing** TextNode — rebuilding the
  node mints a fresh `nodeKey` and legitimately resets the dismissal identity.
- **`page/url-paste/e2e/url-paste-keyboard.ts` (playwright)** — the FORCED
  producer end-to-end: arrows move the highlight, wrap at both ends, Esc
  dismisses, a reopen starts back at row 0, and Enter commits the active row.
  It lives with its consumer because it drives that consumer's paste flow, and
  it exists because a menu with no keyboard model is a menu with *less* code,
  not broken code — tsc and the unit tests both see a perfectly healthy file.
  Two probe hazards it documents inline: caret-menu rows are `<div>`s, not
  `<button>`s (`Row` infers its element from `href`/`onClick`, and these commit
  on `onPointerDown`), and an unselected row's `hover:bg-accent` contains the
  substring `bg-accent`, so the active-row probe must use `classList.contains`.
- **`e2e/caret-trigger-wedge.ts` (playwright)** — all four triggers end-to-end in
  the real app, plus blur/refocus, the arbiter (`@friday [[bar` → only `[[`), and
  that `$$` still lets arrows move the caret. It creates and deletes its own
  scratch page. Three things it has to get right, all learned the hard way:
  `waitUntil: "networkidle"` never settles (the app holds a notifications
  WebSocket); SPA boot can take tens of seconds when this repo's builds have the
  host oversubscribed, so the timeouts are generous rather than tight; and
  clearing a block by backspacing past its start can delete + remount it, which
  drops editor focus — and `open` is focus-gated, so the harness must re-focus or
  every later assertion fails for the wrong reason.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Caret-anchored trigger primitive for Lexical editors: derives open-state from editor text and a single-owner arbiter.
- Web:
  - Uses:
    - `primitives/dom/dom-selection.selectionRect`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/overlay/floating-surface.FloatingSurface`
    - `primitives/overlay/floating-surface.FloatingSurfaceProps`
  - Exports (types):
    - `CanOpenCtx`
    - `CaretQuery`
    - `CaretTriggerMenuProps`
    - `Trigger`
    - `UseCaretMenuOpts`
    - `UseCaretMenuResult`
    - `UseCaretQueryOpts`
    - `UseForcedCaretQueryOpts`
  - Exports (values):
    - `atWordBoundary`
    - `CaretTriggerMenu`
    - `useCaretMenu`
    - `useCaretQuery`
    - `useForcedCaretQuery`
- Cross-plugin:
  - Imported by:
    - `page/editor`
    - `page/inline-date`
    - `page/inline-page-link`
    - `page/math/inline`
    - `page/url-paste`

<!-- AUTOGENERATED:END -->
