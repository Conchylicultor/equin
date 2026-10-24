# The gutter rail has one owner (`RailSeat`)

## Context

A void container (`callout`, `context`) renders no line of its own — it borrows
its first visible child's. On that shared line the four affordances now disagree
about what they act on:

| Control | Acts on | Why |
|---|---|---|
| `⌄` chevron | the **container** | `resolveChevrons` (`web/internal/flatten-blocks.ts`) resolves an explicit owner |
| `+` | the **first child** | `insertBelow(api)`, `api = makeBlockAPI(block.id)` |
| `⠿` drag + menu | the **first child** | `useDraggable({id: drag:${block.id}})` + `<BlockActionsMenu block={block}>` |
| glyph | the **container** | the anchor decoration, mounted at `C` |

Dragging the rail handle on a callout's first line pulls that line *out of the
box* — the reported bug. The intended model is the one the user stated:

> The outermost block owning the line owns its controls. `+`, drag and chevron
> all act on the callout, and the drag handle's click opens the container's own
> popover (Remove / Delete / Collapse / appearance) instead of the block-actions
> menu. The glyph column reverts to the icon picker alone.

**The inconsistency is not a bug in any one control — it is a missing
abstraction.** There are three different encodings of ownership on one line:

- `railLeft: number` (`computeRailLefts`, private to `block-editor.tsx`) —
  **geometry only**. It already walks the frame spans and seats each row at its
  *outermost enclosing container's* content edge, so the surface computes "this
  line belongs to that container" and then discards the identity, keeping the
  x-coordinate.
- `chevron: ChevronTarget` — the **one owner-carrying** prop, and it exists only
  because the chevron was *forced*: an anchor row is zero-height and gutter
  controls are `pointer-events-none` until hovered, so a chevron on the
  container's own row could never be revealed. It re-derives the borrow chain a
  second time because `computeRailLefts` threw that fact away.
- `+` and `⠿` — **implicit self**. Never broken, so never given an owner.

The container grew a parallel set of affordances instead: a second `useDraggable`
on the glyph column and a second block-actions popover (`ContainerAnchorMenu`) in
another plugin. Two drag sources and two menus for one visual line.

The outcome: one resolved seat per row, and a rail component that **cannot see
the row's own block**, so a control targeting the wrong block stops being
expressible rather than being fixed case by case.

## The one deviation from the stated spec, and why

"All four → the container" is right for `+`, drag and the menu unconditionally.
For the **chevron** it cannot be unconditional: there is exactly one chevron slot
on the shared line (a 4th gutter position at `railLeft - 80` overflows the 64px
`BLOCK_GUTTER`), and if the container always claims it, a first child that is
itself collapsed loses the only way back to its children.

That is reachable in one keystroke — `/callout` **wraps** the current block
(`wrapOnConvert`), so wrapping a collapsed toggle, or any block with collapsed
children, hides content behind nothing. It is exactly the failure the
collapsible-container design just eliminated ("a collapsed container always
paints a line, and that line always carries the way back out",
`research/2026-07-30-page-collapsible-void-containers.md`).

So the chevron keeps a single **named allocation rule** with a reachability
justification — the container claims the slot unless the line's own block needs
it, and then the container folds from the rail popover's Collapse item, now one
button away instead of over on the glyph. Concretely:

- first child is a plain line (the common case, and the user's diagram) → **all
  three are the container's**;
- first child has children of its own, or is a `sub-page`/`page-link`/`toggle`
  (`collapsible: "always"`, where the chevron drives the composite-union *mount*,
  not a fold) → `+` and `⠿` are still the container's, the chevron stays the
  child's.

The difference from today is that this is **one explicit field on one type**,
justified once, instead of an accident spread over three prop shapes. Phase 4
(optional) removes the `collapsible: "always"` half of the exception entirely.

*If you want the strict version instead — container always wins the chevron —
say so; it is a two-line change in `resolveRailSeats`, at the cost above.*

## Design

### `RailSeat` — one resolved seat per flat row

New `web/internal/rail-seat.ts`, absorbing `computeRailLefts` and
`borrowedFirstLineCenters` (today unexported locals in `block-editor.tsx`, with
**zero test coverage** because nothing can import them) and `resolveChevrons`
(from `internal/flatten-blocks.ts`). One walk, one export:

```ts
export interface RailSeat {
  /** Content edge the controls hang back from: this row's OUTERMOST enclosing
   *  container FRAME's edge, or its own when unframed. Geometry only. */
  left: number;
  /** The block every rail control acts on: the outermost container whose
   *  BORROWED LINE this row is, else the row's own block. Carries `childCount`
   *  so the menu can offer a fold without a second lookup. */
  owner: { block: Block; childCount: number };
  /** Anchor rows only: the first-line centre the decoration borrows. */
  borrowedFirstLineCenter?: string;
  /** The single chevron slot's target, or null. Usually `owner`; see the
   *  allocation rule above. */
  chevron: { blockId: string; collapsed: boolean } | null;
}

export function resolveRailSeats(
  flat: readonly FlatBlock[],
  spans: readonly FrameSpan[],
  handleOf: (type: string) => BlockHandle<unknown> | undefined,
): RailSeat[];
```

Two rules that must not be conflated, and whose conflation is the current bug —
state both in the module doc:

- **`left` is a SPAN rule.** Every row inside a container's frame seats at the
  frame's edge, so the controls sit outside the box and leave the decoration
  column free (`internal/page-column.ts`).
- **`owner` is a BORROW-CHAIN rule.** Only the borrowed *line* transfers
  ownership — lines 2..n inside the box own themselves. The chain is the
  contiguous run of anchors immediately above the row, each one depth shallower
  (the walk already in `resolveChevrons`); the outermost wins.

### `<BlockRail>` — the structural guarantee

New `web/components/block-rail.tsx`, taking **`{ seat }` and nothing else**. It
renders the chevron, the `+` and the drag handle + menu. It has no access to the
row's block, so "the `+` targets the first child" is not a bug to avoid — it is
unwriteable. `BlockRow` keeps `block` only for `Editor.Block.Dispatch`, the
droppable (drop targets stay per-row), selection and the anchor branch.

### The menu dispatches by owner

`BlockActionsMenu` stays the single rail popover and gains a container arm — it
already has the precedent, a `convertible` branch that drops "Turn into" for page
rows:

- ordinary owner → today's Turn into + Delete;
- anchor owner → the owner's appearance sections, separator, **Collapse/Expand**
  (when `childCount > 1`), **Remove `<label>`**, **Delete**.

Two consequences worth taking deliberately:

- The structural actions become **generic**. `unwrap` is already a generic op and
  `unwrapBlock` is already an editor context action; `Remove callout` derives its
  wording from `handle.label`, so `ContainerAnchorProps.name` disappears rather
  than being threaded through. Per-type *appearance* stays with the type.
- Appearance is reachable from both the glyph and the rail, as specified. The
  same `CalloutAppearance` component renders in both.

The seam is a second field on the existing `Editor.BlockFrame` registration,
beside `anchor`, reusing `Editor.TurnInto`'s exact contribution prop shape:

```ts
export interface BlockFrameMeta {
  anchor?: ComponentType<BlockAnchorProps>;                              // the glyph
  menu?: ComponentType<{ block: Block; api: BlockEditorAPI; close(): void }>; // rail sections
}
```

### What shrinks

- `ContainerAnchor` → glyph + optional appearance popover. It loses `name`,
  `expanded`, `foldable`, `id` and the whole structural block. Its
  static-vs-interactive branch on `editor` stays (read-only surfaces mount it
  with no API).
- `BlockAnchorProps` → `{ type, data, editor? }`.
- The anchor row's `useDraggable` is **deleted**, not merely redundant: leaving it
  would register a second dnd-kit draggable under the same `drag:${containerId}`
  id as the rail's.

## Consequences to accept, and to write down

- **`+` on the borrowed line inserts a sibling AFTER the whole box.**
  `insertAfter` resolves `parentId` to the owner's parent, so the new line lands
  after the container's entire subtree in document order. Semantically right
  ("new block after the callout") and identical to what `+` already does on a
  toggle's line, but it is the most visible behaviour change.
- **The first child loses `+`, drag, and its Turn into / Delete menu.** As
  specified. Lines 2..n are untouched. It also loses its only pointer-driven way
  out of the box; the keyboard routes (Backspace-at-start → `unwrap`, Shift+Tab)
  are unchanged.
- **Dragging moves the whole container** — `move` reparents one row and children
  follow by `parentId`. The `isDescendant` guard already refuses a drop inside
  the dragged subtree, including onto its own borrowed line.
- **Drag feedback.** `isDragging` is keyed on `activeId === f.block.id`, so
  dragging a container dims its (zero-height) anchor row, not the box. Same as
  the glyph drag does today; dimming the frame span is a follow-up, not part of
  this change.

## Files

| Path | Change |
|---|---|
| `editor/web/internal/rail-seat.ts` | **new** — `RailSeat`, `resolveRailSeats` |
| `editor/web/internal/rail-seat.test.ts` | **new** — see Verification |
| `editor/web/components/block-rail.tsx` | **new** — `<BlockRail seat>` |
| `editor/web/components/block-editor.tsx` | delete the two local resolvers; one `railSeats` memo; pass `seat={railSeats[i]!}` |
| `editor/web/internal/flatten-blocks.ts` | `resolveChevrons` + `ChevronTarget` move out; `flattenVisible` stays |
| `editor/web/components/block-row.tsx` | rail markup → `<BlockRail>`; anchor branch drops its draggable |
| `editor/web/components/block-actions-menu.tsx` | container arm |
| `editor/web/slots.ts`, `editor/web/types.ts` | `BlockFrameMeta.menu`; shrink `BlockAnchorProps` |
| `container/web/components/container-anchor.tsx` | glyph + appearance only |
| `callout/web/*`, `context/web/*` | register `menu`; callout's sections move to it |

## Phases (each lands green on its own)

1. **Pure refactor, zero UX change.** Introduce `RailSeat` / `resolveRailSeats` /
   `<BlockRail>` with `owner` = the row's own block for every row. Behaviour is
   byte-identical; the two untested resolvers become testable.
2. **Flip the owner** to the borrow chain's outermost container. `+`, drag and
   the menu move; the anchor's draggable is deleted.
3. **Move the container's menu to the rail.** Add `BlockFrameMeta.menu`, shrink
   `ContainerAnchor` and `BlockAnchorProps`, glyph keeps the icon picker.
4. **Optional, separable.** Retire the `collapsible: "always"` half of the
   chevron exception: give `toggle` an interactive disclosure marker in the
   `MARKER_GUTTER` (Notion's own design; the precedent is `toggle: {field}`'s
   checkbox marker) and `sub-page`/`page-link` an inline mount chevron in their
   icon+title row. The flag's only consumer is the chevron allocation, so it can
   then be dropped from `BlockHandle` — and a `sub-page` first child stops being
   an exception. Note there is **no existing test pinning the mount behaviour**,
   so this phase must add one first.

## Verification

**Unit** — `rail-seat.test.ts` ports the seven `resolveChevrons` cases from
`flatten-blocks.test.ts` and adds the owner/geometry axis these never had:

- borrowed line → owner is the container; **lines 2..n → own themselves** (the
  distinction the current code loses);
- nested containers sharing one borrowed line → owner is the **outermost**;
- unframed row, and a row inside a frame that is not the borrowed line → `left`
  is the frame's edge while `owner` is self (span rule ≠ borrow rule);
- childless anchor → its own one-line fallback seat;
- chevron deferral: a first child with children, and a `collapsible: "always"`
  first child, keep the slot while `owner` stays the container.

```bash
bun test plugins/page/plugins/editor/web/internal plugins/page/plugins/editor/core
bun run test:dom plugins/page/plugins/editor
```

**E2E** — extend `container/e2e/container-collapse-verify.ts` (it already asserts
the chevron targets the container on the borrowed line and is hoverable there):

- the borrowed line's `⠿` click opens **Remove callout / Delete / Collapse**, not
  Turn into;
- dragging it moves the **whole box** (children still inside, box intact);
- `+` on it lands a new line **after** the box;
- line 2's rail still targets line 2 (drag it out; the box keeps the rest);
- the glyph opens the icon picker and nothing else.

`callout/e2e/callout-container-verify.ts` already drives the
`"Reorder or open block actions"` handle and needs its expectation updated.

```bash
./equin build
bun plugins/page/plugins/container/e2e/container-collapse-verify.ts --headed
bun plugins/page/plugins/callout/e2e/callout-container-verify.ts
./equin check
```

**Manual** — `http://att-1785418968-kadw.localhost:9000`: a callout whose first
child is (a) plain text, (b) a toggle with children, (c) a sub-page; a `/context`
nested in a callout; a one-child callout.

## Docs to update

- `editor/CLAUDE.md` — "**An anchor row renders no rail**" is now only half true:
  it renders none *of its own*, because its rail is the one on its borrowed line
  and it owns it. Add the span-rule ≠ borrow-rule statement.
- `container/CLAUDE.md` / `callout/CLAUDE.md` — "The icon popover carries the
  whole block-actions menu" becomes false; the glyph is appearance, the rail is
  structure.
- `editor/web/types.ts`, `editor/web/internal/page-column.ts` — the rail's
  ownership rule beside its geometry rule.
