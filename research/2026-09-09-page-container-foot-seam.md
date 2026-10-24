# The container foot, and the TODO card's launched-run chips

## Context

Launching an agent from a `/todo` card today leaves almost no trace on the card.
The only sign is the card's corner name, which stops hiding and starts spelling
the task's status (`NEED ACTION`, `DONE`) — a word in the top-right corner,
revealed by the same hover that reveals the name. There is no way to get from the
card back to the run it started without opening the dispatch popover again.

The `/prompt` block already solved the same problem: below its text it shows one
chip per conversation it has launched, and clicking a chip opens that run in a
column beside the page. A TODO card cannot do that today, because a container
block has nowhere to put a row of its own — its content IS its children, its
frame is an inert backdrop painted behind the rows, and the two seats a container
can ask for (a gutter glyph, a corner name) both float over the content and
reserve no space.

The mockup (`proto-1788084248-1l6f`, the `chip` variant) puts the chip at the
bottom of the box, below the last child, inside the card's padding. That is a
place the editor does not have. This plan adds it — as a general container seam,
not a TODO special case — and uses it for the TODO card's runs.

Outcome: dispatch an agent from a TODO card and a chip appears at the foot of the
card naming the run, live-following its status, clickable to open it. Dispatch
again and a second chip joins it. A card nobody has dispatched looks exactly as
it does today.

### Decisions taken with the user

- **One chip per run**, not one chip for the task — the same thing `/prompt`
  shows, so the two blocks say the same thing the same way.
- **The corner name goes back to hover-only.** Its `persist`-the-status
  exception exists only because nothing else on the card could spell the status;
  the foot chips now do, and saying it twice is worse than saying it once.
- **Nothing at the foot at rest.** An un-dispatched card is unchanged, reserves
  no row, and keeps its launch where it is (the corner name becomes `▷ Launch`).

## The seam: a container may declare a FOOT

A third thing a container's frame registration may carry, beside its one
decoration and its rail-menu sections:

```ts
// plugins/page/plugins/editor/web/slots.ts — BlockFrameMeta
foot?: ComponentType<BlockFootProps>;
```

It is **not** a third `BlockFrameDecoration` seat and must not join that union: a
decoration answers *what is this box*, is appearance-only, and reserves no space.
A foot is chrome the box makes room for. Keeping it off the union also keeps
`./equin check page-editor:anchor-has-decoration` meaning what it means
today — a container still owes exactly one decoration, and a foot is never one.

`BlockFootProps` (new, in `web/types.ts`) is shaped after `BlockAnchorProps` and
documented as its own contract: `{ type, data, blockId?, editor? }`. Both
optionals degrade the same way they do for an anchor — a read-only surface may
carry no id and hands over no editor, and a foot whose content is live state
returns `null` there rather than lying about a snapshot (the rule
`PromptFooter` already states for `chrome.regions.footer`).

`useBlockFeet()` joins `useFramedBlockTypes` / `useFrameGeometry` /
`useBlockDecorations` / `useBlockFrameMenus` as the fourth twin derived off
`Editor.BlockFrame.useContributions()` — same reason as the others: who has a
foot cannot drift from who paints the box.

## Where the foot renders, and why not anywhere else

**It is flow content in the grid cell of the frame's LAST covered row**, rendered
as a sibling AFTER `<BlockRow>` inside `RowCell`.

This is the one placement that needs no new geometry vocabulary:

- The frame's grid span already covers that row's line, so the card's wash covers
  the foot with no change to `computeFrameSpans` and no change to any
  `gridRow` arithmetic (the three placement sites in `block-editor.tsx` and
  `selection-bands.tsx` stay literally as they are).
- It is in the ROW layer, after the frame in DOM order, so it is clickable — the
  frame itself is `pointer-events-none` and can never host a control.
- Its height is its own. Nothing declares a foot height, so a chip row that wraps
  to two lines grows the card instead of overlapping its last line. (This is the
  reason to reject the alternative of pinning the foot absolutely inside a
  reserved bottom pad: that needs a declared height, and a declared height is a
  silent overlap waiting to happen.)
- It carries no `data-block-id`, so `blockRowsIn` / `rowAtPointer` / the marquee /
  the drop targets do not see it as a row.

A selected card highlights its foot too (the band spans the same grid line);
selecting only the card's last child highlights it as well. That is a known,
accepted cosmetic edge — the alternative is a per-foot grid line and a remap of
every explicit grid placement, which is a much larger blast radius for a
highlight that is one line tall.

No collapse special case: a collapsed card still shows its foot. The foot is
chrome about the card, not its contents.

## The padding algebra: a foot is a CLOSING SLOT

Today the last row a padded frame covers reserves that frame's `padding-bottom`
(`RailSeat.padFramesClosing`), because a backdrop cannot make vertical space. A
foot sits *after* that row's padding, so a footed frame's bottom pad has to move
past it — otherwise the pad lands between the content and the chip and the card
has no bottom edge at all.

Generalise "which ROW closes a frame" to "which SLOT closes it". At flat row `i`
the slots are, in order: the row itself, then the feet of the footed frames
ending at `i`, innermost first (`F₁ ⊂ F₂ ⊂ … ⊂ F_k`).

> A padded frame `P` ending at row `i` reserves its bottom pad on the LAST slot
> contained in `P` — the outermost `F_m` with `F_m.start ≥ P.start`, or the row
> when there is none.

That degenerates exactly to today's behaviour when nothing has a foot, and it is
correct for the nesting that already exists on real pages (the plugin-system page
has a `<todo>` nested inside a `<todo>`): a TODO inside an agent-note, both
padded, gives `[content][gap][chips][todo pad][note pad]`.

Three readers must agree on it, so it is resolved **once**, the way `frameOpenRow`
already is:

- `resolveRailSeats` — `padFramesClosing` per row becomes the ROW slot's count.
- `resolveFramePadInsets` — a frame's `bottom` counts the enclosing padded frames
  that close on the *same slot*, not merely the same row.
- the foot itself — `padding-bottom` is its own slot's count.

Each foot also reserves one `FRAME_PAD_Y` of `padding-top`: the gap between the
card's last line and its chips. `padding-right` is the same count an enclosed row
reserves (`framePadX` of the padded frames covering the container's anchor row,
its own included). `padding-left` aligns with the card's CHILDREN, not with the
box edge — `blockContentLeft(span.depth + 1, absorbingFramesCovering[span.start])`
— so the chips line up under the checkboxes above them, as in the mockup.

### Files

- **New** `plugins/page/plugins/editor/web/internal/frame-foot.ts` — the closing-slot
  resolver and `resolveFrameFeet(...) → FootSeat[]` (`{ block, row, left,
  padFrames, padClosing }`).
- `plugins/page/plugins/editor/web/internal/rail-seat.ts` — `resolveRailSeats` and
  `resolveFramePadInsets` take a `hasFoot: (type) => boolean` predicate and read
  the shared resolver instead of `computeFramePadEdges`' own `closing` array.
- `plugins/page/plugins/editor/web/components/block-editor.tsx` — resolve the feet
  beside the seats, group by row, hand them to `RowCell`.
- **New** `plugins/page/plugins/editor/web/components/frame-foot.tsx` — the padded
  wrapper that dispatches one registered foot.
- `plugins/page/plugins/editor/web/slots.ts`, `web/types.ts` — the field, the props,
  `useBlockFeet()`.

Like `anchor` and `menu`, a foot is **unsealed** — only a field literally named
`component` goes through the framework's error-boundary middleware. Documented,
same as its two neighbours.

### The read-only surface gets the same seam

`plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx`: in the
container-anchor branch, render the foot after the children wrapper, in a div
carrying `paddingLeft: childIndent` plus `framePad`'s right and bottom. The
children wrapper's existing `paddingBottom` becomes the gap, exactly as on the
editable surface. No `editor` prop — which is what makes the TODO foot render
nothing there, correctly: a version-history preview of last Tuesday must not show
today's runs.

## The TODO card

**`plugins/page/plugins/annotations/plugins/todo/web/index.ts`** adds
`foot: TodoFoot` to its existing `Editor.BlockFrame` contribution.

- **New** `todo/web/components/todo-foot.tsx` — `null` without an `editor` or a
  `blockId`; otherwise `<TodoRuns blockId/>`.
- **New** `todo/plugins/task-link/web/components/todo-runs.tsx` — `null` until the
  card has a task, then a `Cluster` of one `ConversationChip` per conversation the
  task has produced, oldest first.
- `todo/plugins/task-link/web/hooks.ts` — new `useTodoTaskConversations(taskId)`,
  the join off the already boot-critical `attemptsResource`. `DispatchedTask` in
  `todo-dispatch.tsx` reads it too (it wants the newest of the same list), so the
  panel and the foot cannot disagree about the card's runs.
- `todo/web/components/todo-anchor.tsx` — drop `persist` and the `STATUS_META`
  lookup. The corner is `Todo` in `text-warning/80`, hover-revealed, dispatched or
  not; the hover action still reads `Launch` / `Launch again`, so the card keeps
  the launch it has today.
- `todo/web/components/todo-frame.tsx` is **unchanged** — the box still repaints
  `success` when the task is done and `muted` when it is dropped. That is the
  tint answering "is there work left here", which no chip replaces.

## One shared chip, instead of a seventh copy

Six places already hand-roll "a `ConversationItem` in something clickable that
calls `openPane(conversationPane, …)`". Two of them are the same *chip*: the
`/prompt` block's `LaunchedConversations` and the one this plan needs.

- **New plugin** `plugins/conversations/plugins/conversation-ui/plugins/chip/` —
  `<ConversationChip conv={…}/>`: a ghost `ToggleChip` wrapping
  `<ConversationItem layout="inline"/>`, opening the run on click and reading
  `active` off `conversationPane.useRouteEntries().at(-1)`, so the run currently
  open beside the page is marked. Sibling of `conversation-ui/plugins/item`, whose
  own contract is "pure presentation, surfaces wrap their own button" — this is
  that wrapper, once.
- `plugins/page/plugins/prompt/plugins/block/web/components/launched-conversations.tsx`
  is rewritten onto it (its task→conversation join stays; only the chip goes).

The other four sites are `Row`s, not chips, and are out of scope — file a
follow-up task for them rather than widening this change.

## Docs to update

`page/editor/CLAUDE.md` (*Container frames*, *A card's padding is declared, not
left over*, *A container that owns no text: the anchor row* — the seat union is
still closed at two, and the foot is explicitly not a seat), `page/container/CLAUDE.md`,
`page/read-only-view/CLAUDE.md`, `todo/CLAUDE.md` and `task-link/CLAUDE.md` (the
corner no longer carries the status), plus a `CLAUDE.md` for the new chip plugin.

## Verification

1. `./equin build` (background), then open
   `http://<worktree>.localhost:9000` on the plugin-system page and look at
   `block-ff1bb4b3-f0aa-4886-8468-d6d05c8a272c` — it is already dispatched
   (`task-1788970312471-y14afy`, `need_action`), so its chip must be there on
   first paint, inside the card's wash, aligned under the card's text, with the
   card's bottom edge below it. `block-6b4d4ded…`'s other TODO cards must be
   pixel-unchanged.
2. The same page carries a `<todo>` nested inside a `<todo>`
   (`block-2159e336…` inside `block-ee4598f3…`) — dispatch the inner one and
   check both boxes still close correctly, one inside the other.
3. `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path /pages/… --out /tmp/todo-foot`
   for before/after, in both colour schemes.
4. Unit: new `internal/frame-foot.test.ts` (bun:test, the `entry(id,type,depth)`
   fixture style `block-frames.test.ts` uses) covering the closing-slot rule —
   no feet ⇒ today's answer; one footed card; a footed card as the last child of
   another card; two footed cards ending on the same row. Extend
   `rail-seat.test.ts`'s *pad counts* and `resolveFramePadInsets` blocks for the
   pad that moved off the last row. Run with
   `./equin test plugins/page/plugins/editor`.
5. e2e: extend
   `plugins/page/plugins/annotations/plugins/todo/plugins/task-link/e2e/todo-dispatch-verify.ts`
   — after a dispatch the card grows a chip at its foot, and clicking it opens the
   conversation column. Re-run `plugins/page/plugins/annotations/e2e/annotations-verify.ts`
   and `plugins/page/plugins/container/e2e/container-*-verify.ts` unchanged: no
   other container declares a foot, so their geometry must not move.
6. `./equin check`.
