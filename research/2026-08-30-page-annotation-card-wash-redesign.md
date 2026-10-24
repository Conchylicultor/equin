# Annotation cards: the wash redesign

## Context

The four annotation cards (`/context`, `/todo`, `/agent`, `/private`) and
`/callout` are the noisiest thing on a page. Each one draws a dashed box, and
each one plants an icon in the left gutter — so a page carrying three of them
reads as a stack of widgets rather than as a document with asides. The owner's
complaint, verbatim: *the annotations should not have an icon at all; only the
callout should; and the callout is itself a bit ugly.*

Six markings were built and compared side by side in a real dummy page —
prototype `proto-1788084248-1l6f`. The chosen one is **wash**: a soft tint, no
border, no icon, and the card's type name appearing only when you point at it.
It was picked against Rule, Gutter, Frame, Underline and Latent, and the launch
affordance was picked in the same pass against four alternatives.

Two facts were measured on the live app rather than read off the docs, and both
shaped this plan:

- `BLOCK_GUTTER` = 64px, `BLOCK_INDENT` = 24px, `BLOCK_INSET` = `md` = **12px**.
- A code block and a place block paint their box at **`[C+12, R−12]`** — the
  block's own content box. A container frame paints at **`[C, R]`**. So the
  container family is the *only* thing on the page whose box does not line up
  with prose, and the invariant recorded in `page-column.ts` ("block decorations
  start at `C`") does not describe what the other decorated types actually do.

## The look

**At rest** a card is a tint and nothing else. No border, no icon, no label.
Which card it is comes from its hue, and the hues are the ones already in use
(`muted` / `info` / `warning` / `destructive`), so a preset switch keeps
restyling them for free.

**On hover** the card's type name fades in at the top-right, *floating over* the
content — absolutely positioned, reserving no space, shifting nothing. It rides a
translucent chip (`bg-background/70` + backdrop blur) so it stays readable when a
long first line runs underneath it. The precedent for that chip is the code
block's language pill.

**The callout keeps its icon** and gains no label: it is the one card whose mark
the author chose, and the emoji says what the label would. Inverted, that is the
family rule — *an annotation is named, a callout is drawn* — and it replaces
"dashed vs solid" as what separates them.

**The TODO card's launch action is the label itself.** Hover the card, the label
reads `TODO`; move onto the label and it becomes `▷ LAUNCH`; click opens the
dispatch popover that exists today, unchanged. Nothing is added at rest, which is
the right cost for an action most TODOs never use. A TODO that *has* been
dispatched keeps its label visible at rest, reading the task's status
(`RUNNING`, `DONE`) — that is live state worth seeing, and it is where the status
the glyph carries today goes.

The four icons (`MdRule`, `MdPendingActions`, `MdAutoAwesome`,
`MdVisibilityOff`) are not deleted — they stay on the block handles, where the
slash menu and the turn-into list read them. They just leave the card.

## 1 · Alignment: a frame paints its content box

The whole fix is that a container frame should paint the same box every other
decorated block paints.

| | today | after |
|---|---|---|
| prose text | `[C+12, R−12]` | unchanged |
| code / place box | `[C+12, R−12]` | unchanged |
| **container frame** | **`[C, R]`** | **`[C+12, R−12]`** |

- `plugins/page/plugins/editor/web/internal/page-column.ts` — add the one
  derivation both consumers read, e.g. `frameBoxEdges(depth)` returning the left
  offset and the right inset as CSS lengths, built from `blockContentLeft(depth)`
  and `spaceLength(BLOCK_INSET)` (`@plugins/primitives/plugins/css/plugins/space-ramp/core`
  — a `var(--space-md)` reference, so it stays density-reactive; never a px
  literal). Correct the module doc: decorations paint the **content box**, not
  `C`. `C` remains what it is — the decoration *origin* the surface computes and
  the rail seats against.
- `plugins/page/plugins/container/web/components/container-backdrop.tsx` —
  `left`/`right` come from that helper instead of `left: inset, right: 0`.
  Its doc comment's "no horizontal offset beyond `inset`" rule is what this
  changes, and the reason it was safe to change goes in its place: the offset is
  the surface's own, identical for every frame, and moves no row's flow.
- `plugins/page/plugins/editor/web/components/block-row.tsx` — the anchor column
  (`ANCHOR_COLUMN`, `style={{ left: contentLeft, width: BLOCK_INDENT }}`) shifts
  by the same inset, so the callout's emoji stays inside its box. Both call the
  helper; neither computes the offset.

Inner padding lands at 24px left (`BLOCK_INDENT`) and 12px right. To get that
12px right, rows enclosed in a frame must reserve it: `RailSeat`
(`editor/web/internal/rail-seat.ts`) already resolves each row's enclosing frame,
so it gains the frame depth and `BlockRow` applies `paddingRight` the way it
already applies `paddingLeft`. **If that plumbing turns out to reach further than
expected, fall back to `right: 0`** — the left edge is what was complained about,
and the right edge is then no worse than today.

`page/quote` inherits all of this and needs no edit of its own.

## 2 · A decoration has two possible seats

Today `Editor.BlockFrame({ match, component, anchor })` implies one seat: a
`BLOCK_INDENT`-wide column at `C`, centred on the first child's borrowed line.
The corner label is a second seat, and a container has exactly one decoration —
so make the two arms mutually exclusive rather than adding a flag:

```ts
Editor.BlockFrame({ match, component, anchor: Comp })        // gutter glyph — callout, quote
Editor.BlockFrame({ match, component, cornerAnchor: Comp })  // corner label — the four annotations
```

A union type (`{ anchor: C; cornerAnchor?: never } | { cornerAnchor: C; anchor?: never }`)
makes "both" and "neither" unspellable. `./equin check
page-editor:anchor-has-decoration` (`plugins/page/plugins/editor/check/index.ts:215`)
accepts either arm — it asserts a handle's `anchor: true` is backed by *a*
decoration, and that stays exactly as true.

`BlockRow`'s anchored branch grows a second positioning case: `top: 0`, right
edge from `frameBoxEdges`, `z-raised`. The anchor row sits at the frame span's
top and is zero-height, so `top: 0` *is* the box's top-right corner — no new
geometry to invent, and the surface still owns all of it.

**Hover** cannot be pure CSS here: the frame is a backdrop and the rows are its
grid siblings, with no common ancestor to hang `group-hover` on, and the frame
wrapper is `pointer-events-none` (`block-editor.tsx:1636`) so it can never be
hovered itself. So the editor tracks it: rows report pointer enter/leave, the
editor holds the hovered frame chain (a row's enclosing frames, which the span
map already yields), and `BlockRow` hands the corner anchor a `hovered` flag.

A shared `CornerLabel` in `plugins/page/plugins/container/web` renders the chip
and owns the reveal for both surfaces:
`cn("opacity-0 transition-opacity group-hover/frame:opacity-100", (hovered || persist) && "opacity-100")`.
The editor drives it with the flag; `read-only-view` — which nests through real
wrapper divs — drives it by putting `group/frame` on the wrapper and passing
nothing. One component, one look, two surfaces.

## 3 · Per-plugin appearance

Each of the four frames drops its border and keeps its hue — the tint strings
stay with each plugin, per the family's existing rule that a card owns its own
tint:

- `annotations/plugins/context/web/components/context-frame.tsx`
  `"rounded-md border border-dashed border-border bg-muted/40"` → `"rounded-md bg-muted/40"`
- `agent-notes-frame.tsx` → `"rounded-md bg-info/10"`
- `private-notes-frame.tsx` → `"rounded-md bg-destructive/5"` (lift the alpha if it reads too faint without its border)
- `todo-frame.tsx` — the three `TINTS` (open / done / dropped) lose their borders the same way

The four `*-anchor.tsx` files become corner labels:

- **context**, **private-note** — a `CornerLabel` with the type's name, inert, no
  popover (they have no appearance and no action, exactly as today).
- **agent-note** — the label is the trigger that opens the authorship list, in
  place of the glyph; with no authors it stays inert.
- **todo** — below.

`callout` changes in one way only: it inherits the new box. Its
`CalloutAnchor` / `CalloutFrame` / colour maps are untouched.

## 4 · The TODO launch

Nothing about the dispatch mechanism changes — the popover
(`annotations/plugins/todo/plugins/task-link/web/components/todo-dispatch.tsx`),
the endpoint (`POST /api/todo-blocks/:blockId/task`), the idempotent
`ensureTodoTask`, the rail-menu twin (`todo-menu.tsx`) and `useTodoTaskState` all
stay as they are. Only the trigger moves, from the glyph to the label:

- undispatched: hidden at rest → `TODO` on card hover → `▷ LAUNCH` on label
  hover → same popover on click;
- dispatched: visible at rest, reading `STATUS_META[status].label` in the status
  hue — the same table the task list reads, so the card and the task can still
  never disagree — and clicking it opens the same panel, which already shows the
  dispatched task and offers another run.

## 5 · Docs and e2e that record the old look

- `plugins/page/plugins/annotations/CLAUDE.md` — *"The tints are one visual
  language"* says all four are dashed and that dashed is the family signature.
  Rewrite: the signature is now *named, not drawn*.
- `plugins/page/plugins/container/CLAUDE.md` — the two seats, and the frame's
  content-box geometry.
- `plugins/page/plugins/callout/CLAUDE.md` — it explicitly records "why the tint
  bleeds to `C` rather than `C + BLOCK_INSET`"; that rationale is being reversed
  and must be replaced, not left standing.
- `plugins/page/plugins/annotations/e2e/annotations-verify.ts` — asserts
  `box.dashed` and four distinct **border** colours (~lines 349–353). Both go:
  assert no border, and four distinct **background** colours. Its generic
  `geometry()` box-detection keeps working, since it also detects a
  non-transparent background.
- `callout/e2e/callout-container-verify.ts` and
  `annotations/plugins/context/e2e/context-container-verify.ts` — assert the
  glyph sits within `[C, C+BLOCK_INDENT]` and that box edges sit at `C`; both
  move by `BLOCK_INSET`.
- `container/e2e/container-rail-verify.ts` — keys off `aria-label`s
  (`"Dispatch an agent"`, `"Agent notes authorship"`); keep those strings on the
  label triggers so the rail suite keeps passing.

## Verification

1. `./equin build` (background), then open a page carrying all five card
   types — `http://<worktree>.localhost:9000/pages/page/block-6ba6822e-3abf-4cd9-87f9-494360a2b1cb`
   has a callout, agent-notes and a quote; `block-b4f38ca7-…` has context + todo.
2. Measure, don't eyeball, the thing that was wrong: every decorated box's left
   edge and a paragraph's first letter must share one x. The probe used to find
   the bug (walk `[data-block-id]` rows, report each background-bearing
   descendant's rect) is the check.
3. Hover each card: label fades in, nothing moves. Hover a TODO's label: it
   becomes `▷ LAUNCH`. Click: the dispatch popover opens. Launch: the label
   sticks at rest showing the status.
4. `./equin run plugins/page/plugins/annotations/e2e/annotations-verify.ts`,
   then the callout, context, quote and container-rail suites.
5. Open a page in version history (`read-only-view`) and confirm the same cards
   render with the tint and a hover label, and that the callout's glyph is inert.
6. `./equin check` — `page-editor:anchor-has-decoration`,
   `annotations:audience-declared`, boundaries, type-check.
