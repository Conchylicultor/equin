# editor

## The sidebar's ordering space is `docRank`, not `rank`

`page_blocks.rank` is a fractional index, comparable **only within one
`(parent_id, rank)` space**. The Pages sidebar's sibling group is *pages sharing
a `pageId`*, which spans several such spaces — so two of its rows legitimately
hold the same rank, and `Rank.between("a1", "a1")` throws inside `computeDrop`.

So the **server** defines the order, and stores it: `page_blocks.doc_rank`
(nullable `rank_text`; NULL on content rows). The live `pagesTree` set and
`GET /api/pages` emit a `PageRow` = `Block` + **`docRank`** read straight off the
column — the HTTP read ordered by `(page_id, doc_rank)`, the set by `createdAt`
and sorted by `docRank` where it renders (the sidebar's `inDocOrder`, since the
tree keeps its incoming child order) — so **display order, array order, and
`computeFlatReorder`'s rank-sorted neighbourhood are one order**. See
[`research/2026-07-16-page-sidebar-document-order.md`](../../../../research/2026-07-16-page-sidebar-document-order.md)
and, for the column,
[`research/2026-10-08-global-page-tree-and-agents-routed.md`](../../../../research/2026-10-08-global-page-tree-and-agents-routed.md) §2, §4.1.

> **Invariant I-DR.** For each group P (live page rows sharing `page_id`; NULL
> is the root group), ordering by `doc_rank` equals document order —
> `docOrderRows` + `compareDocOrder`: rank-ordered DFS pre-order, stopping at
> nested pages.

**Why a column.** The order used to be minted per load (`Rank.nBetween` over
every group, on every read), which a routed collection cannot carry: one page
insert re-keyed every sibling, and dragging a toggle that holds a sub-page moves
the sub-page without any write to its row. A maintained column turns a reorder
into an ordinary write of the rows that moved.

**How it is maintained — at the one structural-write chokepoint.**

- **Marks in the lowest-level mutators.** `insertBlocks`, `updateBlockFields`
  (only when it names `parentId`, `rank`, `type`, `pageId` or `deletedAt` —
  recording the OLD `page_id` too when it names `pageId`), `trashBlockRoots`,
  `untrashBlockRoots`, `deleteBlockRoots` and `recomputePageIdSubtree` (old and
  new `page_id`, via `UPDATE … RETURNING`) record the groups they wrote in a
  module-private `WeakMap<PageForestTx, Set<scope>>` (`doc-order-dirty.ts`).
  Every composite writer inherits them; nothing above the mutators knows they
  exist.
- **Reconcile in `withPageForest`**, after `fn(ctx)` and before the watermark
  (`doc-rank.ts`): one partition-scoped `docOrderRows` (the upward CTE, seeded
  only by the dirty groups' pages), sorted in JS by `compareDocOrder`, then
  `planDocRanks` (`core/doc-rank.ts`, pure) keeps the longest strictly
  increasing run of existing keys and re-mints the rest with
  `Rank.nBetween(prev, next, n)`, and `writeDocRanks` writes only the changes,
  in one statement. `planDocRanks` throws if its own output is not strictly
  ascending — there is no unique index to catch a duplicate later.
- **Cost.** A data-only write (the typing projection, a rename, an icon, a fold)
  marks nothing: **0 queries**. A structural op in a page with no sub-pages: one
  indexed CTE returning nothing. A drag that reorders k sub-pages: one UPDATE of
  at most k rows.
- **Boot reconcile** (`onReadyBlocking`, after `database`'s migrations, before
  the backend serves — `doc-rank-boot.ts`): plans against the global
  `docOrderRows()`, then re-mints through `withPageForest` over exactly the
  groups that need it, so the write is re-planned under their locks. A database
  whose live pages hold no key yet is the one-time **backfill** (silent); any
  other change is **drift** — a writer that bypassed the marks, or an old backend
  writing during a hot-swap — repaired and announced on `docRankDriftSink`
  (`doc-rank-drift-sink.ts`), which `reports/page-doc-rank-drift` files as a
  `page-doc-rank-drift` report. A sink, never a `reports` import: this barrel
  is loaded by drizzle-kit through `_blocks`, and `reports/server` throws at
  module eval outside a backend (`schema-files-loadable`). Idempotent.
- **`docRank` is `touchedBy: false`**: a re-mint never moves `updated_at`, so a
  sibling re-spaced around a drag does not jump in Recent pages.

Rules that still hold:

- **`docRank` is never written into `rank`, and never in a request body.**
  `NewBlockRow` / `BlockColumnChanges` cannot name it, so `writeDocRanks` is its
  only writer; moves send **positional intent** (an anchor id) and the server
  mints the rank against the full sibling set. The same row read through
  `pageBlocks` carries no `docRank` — that resource orders by `rank`, inside one
  `(parent_id, rank)` space, where it is meaningful.
- **Membership is never a function of the traversal.** `docOrderRows`' driving
  relation is the plain select of live page rows; the path CTE is LEFT-joined
  onto it. A page whose path can't resolve keeps its row (`path: null`, sorted
  last in its group by raw `rank`) and is still given a key. (Only corruption
  reaches that branch — a live page can never point at a trashed parent.)
- **Don't move the sort into SQL.** `rank_text` is `TEXT COLLATE "C"`, but a
  recursive CTE can flatten the domain back to plain `text` and revert to locale
  collation, where `'a' < 'B'` while `Rank.compare` says `'B' < 'a'`. (The
  loader's `ORDER BY doc_rank` is fine: it orders the column itself, not a CTE
  output.)
- **A live page with no `doc_rank` is a loud loader error**, naming the row —
  never minted over at read time. It means a write bypassed the marks; the next
  structural write in that group, or the next boot, repairs it.

`docRank` derives from **ranks, not content**, so the ~1s `data.text` projection
of a content block marks nothing and re-mints nothing.

## The page tree is a routed collection (`pagesTree`, key `pages.tree`)

Every live page — `liveCollection("pages.tree", { all: { orderBy: createdAt,
unbounded } })`, no preload — served by `serveCollection` over the
`page_blocks` TABLE (`server/internal/page-rows.ts`, the ONE spelling the server
and the tests compile): `where type = 'page' AND deleted_at IS NULL`, every
block wire field by name, `docRank` included — bound to `doc_rank` BY NAME.
The column is nullable (content rows hold NULL) and the binding states no
non-null claim: the `all` compiler refuses an `expr` that is exactly one
column, and a base column's nullability is not checked. I-DR keeps it set on
every live page, and a leaked NULL is caught only where it lands — the row
schema's `RankSchema` fails the load or refill, so the whole tuple errors
loudly (the sidebar shows the error) rather than one row sorting anywhere. Readers:
`useLive(pagesTree)` where they need the whole set (sidebar, `usePageOptions`,
breadcrumb, delete-action ancestry, Recent pages), `useLiveRow(pagesTree, id)`
for one page (header, cover, kind control, pane resolvers and titles, the
link block, the inline node and the page chips).

**Declared by fields, over the `page_blocks` entity.** `pagesTree` is
`liveCollection({ from: pagesEntityRef, fields: { editedAt }, carry })`
(`core/block-entity.ts`): `pagesEntityRef = entityRef("page_blocks",
blockFields)`, the block WIRE fields (`BlockSchema`'s; `rank` / `docRank` as the
`Rank` value object, `rankWireField`). The table itself stays the raw
`pgTable` — its CHECK constraint (`page_blocks_trash_flags_agree`) has no
spelling in an entity's meta and its `data` column is branded `BlockData` — so
the ref names it for the browser and the server binds its fields by column
name. Because the rows reach that entity, every extension EXPOSING fields of a
block folds into them under `$columns` (starred, agent-origin's `origin`, page
tags' `tags`), and the pages sidebar derives them with no field code. The
derived row is pinned equal to `PageRow` (`_PinPagesTreeRow`).

**`blockLocations`** (`page.block-locations`, lookup-only `:rows`) is the
reverse lookup `pagesTree` cannot answer: any live block's `{ id, type, pageId }`,
content blocks included, served over `page_blocks` with `deleted_at IS NULL` as
its base membership. `useBlockTarget` (page-tree) resolves a bare block id
through it; only the projected columns route, so a content edit reaches no
reader. `GET /api/blocks/:id/page` (`getBlockPage`) answers the same question
over plain HTTP for the page-link e2e script only.

- **Order is `createdAt` because it never moves**: a `doc_rank` re-mint is then
  an in-place refill of the re-minted rows, never an `orderOf`. A surface that
  renders the tree sorts by `docRank` itself.
- **`editedAt` — when the page was last edited**, over its row AND its
  content (a content edit stamps only the edited block's row, never the page
  row). It is `pageEditedAtSql` (`server/internal/page-rows.ts`, the one
  spelling): `greatest(page row updated_at, rollup edited_at)`, where the
  rollup is `page_content_edited_at` (`server/internal/rollup-spec.ts`, a
  `derived-tables` rollup: per page, `max(updated_at)` over its live blocks
  with `page_id` = it, sub-page rows included), LEFT-joined on the page id and
  routed through its one source, `page_blocks` carrying `page_id`.
  `readPageEditedAt` (markdown-apply's `<page-meta>`) reads the same
  expression over the same rollup, so the header's "Edited" label
  (`useLiveRow(pagesTree, id).editedAt`), the sidebar's Recent section, the
  Welcome page's Recent pages and `<page-meta>` cannot disagree. A typing
  write re-aggregates one page (`page_blocks_page_id_idx`) and refills its one
  row.
- **Costs**, pinned per step by `server/internal/pages-tree-oracle.test.ts` on
  the tree oracle: a content block's write (the typing projection) is its
  page's refill (its `editedAt` moved), a write the rollup does not read (a
  fold toggle) nothing; a rename / icon / cover / kind write is that page's refill; a toggle
  drag refills exactly the pages the reconcile re-minted; a create or restore
  is one refill and one `orderOf`; a trash an exit after a one-id probe (the
  `where` reads `deleted_at`).
- **The key is new** (it was the legacy push resource `pages`), so a tab still
  running an old bundle is refused `unknown-key` — the skew/Reload prompt — not
  handed keyed deltas its non-keyed read cannot apply (C39, pinned by the same
  suite).

`doc-rank.test.ts` is the writer oracle: random op sequences across every
structural writer (ops, patches, trash/restore, cross-page moves,
turn-into-page) asserting I-DR against the global `docOrderRows()` after every
step, plus the depth-2 to-do-under-to-do drag and the 0-query data-only patch.

## The page column (one owner for the content-left edge)

`web/internal/page-column.ts` is the **single declaration site** for the column's
horizontal geometry. The invariant:

> A page's block content box has a left edge `C`.
>
> - `C` is the ORIGIN the surface computes and the rail seats against — where a
>   block's box is measured from, not where paint lands.
> - Block **content** (text, media) insets from `C` by `BLOCK_INSET`.
> - Block **decorations paint that same content box**, so a box's own edge and
>   the first letter of the prose above it share one x: a code background, a
>   place card, a callout tint, a quote rule, an annotation card's wash
>   (`frameBoxLeft`).
> - **How far a box's CONTENT stays off those edges is a separate declaration**
>   — `FRAME_PAD_X` / `FRAME_PAD_Y`, below. Alignment places the edge and has no
>   opinion about padding; for a while nothing else had one either, and the four
>   sides of a card disagreed by 24px.
> - The two exceptions are the marks that are not boxes: the block-selection
>   highlight and the diff rail still start at `C`, so a selected card's band
>   surrounds its tint rather than tracing it — a highlight wants padding around
>   the thing it highlights, and a box wants to line up with the prose.
> - Anything a host renders *alongside* blocks that is not itself a block — page
>   title, page icon, section list — sits at `C + BLOCK_INSET`.

This invariant used to read "block decorations start at `C`", and the container
frame was the only thing that believed it — an ordinary decorated block paints
inside its own `<Inset x={BLOCK_INSET}>` content box and always did. So a
callout's tint stood one `BLOCK_INSET` to the LEFT of every paragraph on the page
and of every other decorated box, which is what "the card looks shifted" was.
Measured on the deployed app, then fixed.

The editable surface reserves the hover rail (`BLOCK_GUTTER`, 64px) to the **left**
of `C`, inside each row's own padding so the `+` / drag / chevron controls are
hoverable. Editable-surface-only: `read-only-view` has no rail, so its `C` is the
renderer's left edge. `BLOCK_INSET` is shared by both.

A row seats those controls against the content edge of its **outermost enclosing
container frame** — which for an unframed row is its own. A container that owns no
text (the callout anchor) paints its decoration in the `BLOCK_INDENT` column at its
own `C`, which is exactly where its first child's chevron would sit under the naive
rule; the child's row is later in DOM order at the same `z-raised` level, so the
decoration would be not merely overlapped but **unclickable**. Seating the enclosed
rows' rail at the frame's edge puts the controls *outside* the box and leaves that
column free. `BlockRow` takes the resolved seat as a prop and still computes no
geometry itself — `block-editor.tsx` derives it from the `frameSpans` it already
has (`internal/rail-seat.ts`).

**The span rule is not the ownership rule** — that pair is stated once, in
`internal/rail-seat.ts`, because conflating them was the bug that motivated the
`RailSeat` abstraction. `left` is a SPAN rule: *every* row inside a frame seats at
the frame's edge, the borrowed first line and lines 2..n alike. `owner` — which
block the rail's controls act on — is a BORROW-CHAIN rule: only the borrowed
*line* transfers ownership, so lines 2..n own themselves.

**Hosts never compute the edge.** `BLOCK_GUTTER` is deliberately *not* exported from
the web barrel — a host that re-adds it to its own wrapper's padding drifts the title
off the block text's edge. Instead: editable page surface → `<PageContentColumn>`
(rail + inset); read-only surfaces → `<Inset x={BLOCK_INSET}>` with
`<ReadOnlyBlocks>` flush at `C`; a new block type → `<Inset x={BLOCK_INSET} y="…">`
(vertical padding is *not* part of `BLOCK_INSET` — it differs per block).

Never splice a ramp step into a class name (`` `pl-${BLOCK_INSET}` ``): Tailwind emits
an `@utility` only for literal tokens it can scan. Use `<Inset>`, or `insetClass()`
from the spacing primitive when you only have a `className`.

The code background sits at `C + BLOCK_INSET` (its `px` wrapper is outside the
decoration) and was once recorded here as the invariant's one deviation. It is
the RULE now, and the container frames were the deviation: a frame is handed `C`
as `inset` and adds the same `BLOCK_INSET` itself (once, in `ContainerBackdrop`),
so every decorated box on the page lines up.

`blockContentLeft(depth)` is the one derivation of `C` in the editable surface's
row coordinates. A container frame insets its decoration to it, and the editor
evaluates it — at a row's own depth, or at its outermost enclosing frame's — to
hand each `BlockRow` its `railLeft`; nobody re-derives `BLOCK_GUTTER + depth *
BLOCK_INDENT` by hand.

## Container frames (the one exception to the flat list)

The forest renders as a **flat list of sibling rows**, and `flattenTree`'s comment
says why: every block stays in the same React parent, so indent/outdent/move only
reorder keyed elements and a block's Lexical instance (and its focus) survives.
The direct consequence is that a block renderer can only ever paint its OWN row —
a block's children are not its DOM children, so it cannot draw a box around them.

`Editor.BlockFrame` is the seam for the other half. A block type that contributes
one becomes a **container**: `internal/block-frames.ts` groups its visible
subtree — always a contiguous run in a depth-first flatten — and hands it to the
contribution as `children`, which paints the box around the lot. A collapsed
container still gets a frame around its own row (the box must not blink out when
you collapse it), and containers nest.

Three rules keep the exception from eating the rule it excepts:

- **Only contributing types are grouped.** Membership is derived from the
  slot's own registered matches (`useIsFramedBlock`), not from a separate flag
  that could drift from it. Every non-container block keeps the flat guarantee
  exactly as before.
- **Membership is per BLOCK, not per type.** A registration may declare
  `applies(block)` — a pure function of the row's `type`, `data` and fold — for a
  type that is a container only in some states: an agent-authored or
  instructions sub-page is a card while expanded inline (`page/sub-page`) and a
  plain row otherwise. Spans read it, so every pad, inset, foot and rail-seat
  count follows; a block it answers no for is exactly an unframed block. The
  geometry maps stay keyed by type — they are only ever read over spans.
- **A frame is appearance only, and geometry is not its to touch.** It is a
  BACKDROP: it has no flow of its own, so it cannot shift a row and cannot make
  the space its own padding needs. Left padding or a left border in the *flow*
  is not available either: rows seat their gutter controls against a content
  edge the SURFACE computed (this frame's, for the rows inside it), so shifting
  the flow would strand them. Decorations inset to the `inset` prop instead, and
  padding is reserved by the rows — see *A card's padding is declared, not left
  over*.
- **Geometry keeps reading the DOM.** Drag/drop, drop zones and the marquee all
  measure live rects via `[data-block-id]` + `getBoundingClientRect()`, never
  React tree position, so an extra wrapper perturbs none of them.

The cost this buys back: moving a block INTO or OUT OF a frame changes its DOM
parent, which remounts its Lexical instance. It fires only on that transition
(never per keystroke), and the block's content owner outlives the remount (one
deferred session end — see *One owner per block*) so text survives;
`e2e/indent-caret-verify.ts` is the caret spec.

A container may also declare a **foot** (`BlockFrameMeta.foot`): a strip of its
own chrome at the bottom of the box, below the last visible child and inside the
card's padding — the TODO card's chips for the runs it launched. It is the one
thing on a container that is neither the box nor a decoration, and the reason it
is a field of its own rather than a third `BlockFrameDecoration` seat is that the
two answer different questions. A decoration answers *what is this box*: it
floats over the content and reserves no space, which is why a container may have
exactly one. A foot is chrome the box MAKES ROOM FOR — its height is its own, so
a chip row that wraps to two lines grows the card instead of overlapping its last
line, and the card's bottom pad moves below it (*A card's padding is declared*,
below). Folding it into the decoration union would also force a card to choose
between having a name and having a foot, and would quietly change what
`page-editor:anchor-has-decoration` pins.

It renders as a sibling AFTER `<BlockRow>` inside the grid cell of the frame's
LAST covered row, which is the placement that needs no new geometry vocabulary:
the frame already spans that row's grid line, so the card's wash covers the foot
with no change to `computeFrameSpans` and no change to any `gridRow` arithmetic
anywhere. It is in the ROW layer and after the frame in DOM order, so unlike the
frame it can carry controls. And it carries **no `data-block-id`** — `blockRowsIn`
/ `rowAtPointer`, the marquee and every drop target find rows by that attribute,
and a foot is chrome ABOUT a card rather than a line IN it.

Two consequences are accepted rather than solved. A selected card highlights its
foot too (the band spans the same grid line), as does selecting only the card's
last child; the alternative is a per-foot grid line and a remap of every explicit
grid placement, which is a large blast radius for a highlight one line tall. And
a card whose LAST CHILD is another card ends on the same grid row, so the inner
card's box — which spans that row's whole cell — paints over the outer card's
foot. A backdrop spanning a grid line cannot end above flow content inside that
line, so this is a property of the placement, not a bug in the pad arithmetic
(which does put the outer card's pad below its own foot, and leaves the inner
card's on the row). The nesting that occurs in practice is the other orientation
— a footed TODO inside an agent-note — and that one lands correctly.

`read-only-view` renders the forest recursively, so it dispatches the same slot
with `inset: 0` (no hover rail there) — one contribution, both surfaces.

### A card's padding is declared, not left over

> The gap between the box a container paints and the text inside it is ONE
> declared quantity per axis (`FRAME_PAD_X` / `FRAME_PAD_Y`, `page-column.ts`),
> read by every side of every box.

Before it existed, the box's edges and its content's edges were computed
independently — from quantities chosen for ALIGNMENT — and whatever fell out
between them became the padding by accident. Measured on the deployed app, a
`/todo` card had **24px on the left, 0 on the right, 0 top and 0 bottom**: text
landing exactly on its own tint, which reads as a clipping bug. The right gap was
zero for a specific reason worth not reintroducing — the frame pulled its edge in
by the SAME count the rows reserved as `padding-right`, so the reserve equalled
the pull and both landed on one x. One count where two are needed.

- **X is pinned to `BLOCK_INDENT`; Y is free and smaller.** The left gap is not
  a choice: the box starts on the prose x and the card's children are one indent
  level deeper, so it IS the indent step. `FRAME_PAD_X` is therefore declared AS
  that constant — the other three sides are made to agree with the one that was
  already decided. `FRAME_PAD_Y` is a token, and deliberately less: a horizontal
  gap is measured to a glyph, a vertical one to a LINE BOX that already carries
  the row's `py-xs` plus half its leading, so equal numbers would not read equal.
- **Two counts, one apart, and the difference IS the padding.** A ROW reserves
  one pad per frame enclosing it (`padFrames`); a FRAME pulls its own box in by
  one pad per frame enclosing IT, its own excluded. So the innermost box ends one
  pad outside the text, and each box further out ends one pad outside the box it
  wraps.
- **A backdrop cannot buy vertical space**, so the rows make it: the first row a
  padded frame covers reserves `padding-top`, the last reserves `padding-bottom`
  (`padFramesOpening` / `padFramesClosing`). The frame's `topInset`/`bottomInset`
  are only its NESTING share — without them every box in a nest would share one
  top edge, since every anchor row is zero-height.
- **A frame closes on a SLOT, not on a row.** A container that declares a FOOT
  renders it after that last row, still inside the box — so the card's bottom pad
  has to move past it, or the pad lands between the card's last line and its
  chrome and the card has no bottom edge at all. At flat row `i` the slots are,
  in order: the row itself, then the feet of the footed frames ending at `i`,
  innermost first (`F₁ ⊂ F₂ ⊂ … ⊂ F_k`, which is also the order they render in).

  > A frame `P` ending at row `i` reserves its bottom pad on the LAST slot
  > CONTAINED in `P` — the outermost `F_m` with `F_m.start ≥ P.start`, or the row
  > when there is none.

  Spans nest and never partially overlap, so `F.start ≥ P.start` is exactly
  `F ⊆ P`; a footed frame is a candidate for its own pad, since its foot is the
  last thing inside it. With nothing declaring a foot the rule degenerates, byte
  for byte, to "the last row closes it". A TODO ending an agent-note, both padded,
  gives `[content][gap][chips][todo pad][note pad]` — both pads below the one
  foot. The reverse nesting is not symmetric and must not be made so: a card
  INSIDE a footed card keeps its pad on the row, because the outer foot renders
  after that row and is outside the inner box entirely.

  Three readers must agree about this, so it is resolved once, the way
  `frameOpenRow` already is (`internal/frame-foot.ts`): the row's
  `padding-bottom` (`resolveRailSeats`), which enclosing frames' pads sit BELOW a
  box (`resolveFramePadInsets`, which therefore compares SLOT KEYS and not
  `end` indices), and the foot's own `padding-bottom`. The foot's other three
  sides are the surface's too: it aligns with the card's CHILDREN rather than
  with the box edge, clears the box's right edge by the same count an enclosed
  row does, and reserves one pad of `padding-top` as the gap between the card's
  last line and its chrome.
- **The reserve is never on the anchor row.** It is zero-height by design; the
  resolver walks past the run of anchors a span opens with and lands the pad on
  the first row that renders a line. A CHILDLESS container is the exception and
  pads its own row, which is where its one-line fallback is.
- **`--gutter-first-line-center` adds the pad above it** (`firstLinePad`), or the
  rail's buttons seat in the card's top padding instead of beside its first line.
- **Whether a container pads at all is ITS declaration** — `BlockFrameMeta.pad`,
  required. `"box"` for a filled shape (callout, the four annotation cards);
  `"rule"` for one that paints no box (the quote's left bar), which has no edge
  to clear and whose passage would only be narrowed by a pad. `"rule"` frames are
  filtered out before any pad is counted, so a card nested inside a quote is
  padded exactly once, by itself.
- **`read-only-view` reserves the same pad on its wrappers.** Its nesting is real
  wrapper divs rather than a shared grid, so the wrapper carries the padding and
  its frame has no nesting share to pull in by.

### A container that owns no text: the anchor row

A frame-contributing block can go one step further and own **no line of its own**:
`BlockHandle.anchor` says its content *is* its children. The callout is the one
today — a void `{icon, color}` payload whose first line is an
ordinary `text` child, so converting that child to a heading cannot touch the
container, and Enter inside it is a plain sibling split rather than a second
callout.

Four rules, each closing a failure the naive version has:

- **Zero height only while it has visible children.** `computeFrameSpans`
  deliberately spans a childless container over its own row alone (the box must
  not blink out when you collapse it) — at zero height that paints a 0px frame
  over a 0px row, i.e. an invisible, unclickable, undeletable ghost. With no
  children the row falls back to one empty line instead.
- **It borrows its first child's line** — for the gutter seat, and for the fold
  (see *A container folds to its borrowed line* below). It declares no
  `collapsible` and its stored `expanded` is live. This used to be
  `collapsible: "never"` with the flag made *inert*, because an anchor had no
  chevron to reopen itself with; folding to the borrowed line means a collapsed
  container always paints a line and that line always carries the chevron, so
  the flag is safe to mean what it says.
- **The decoration lives in the row layer, never the frame.** Frames are emitted
  before the rows and are `pointer-events-none`, so an interactive control there
  is hit-tested under the following row. The decoration rides on the
  `Editor.BlockFrame` contribution precisely so it cannot drift from who actually
  paints a box, but the *surface* mounts it — in one of TWO seats, and which
  field the registration spells says which:
  - **`anchor`** — a glyph in the `BLOCK_INDENT` column at the box's own left
    edge, seated on the first visible child's borrowed first-line centre, since
    an anchor has no line of its own to measure. The callout's icon.
  - **`cornerAnchor`** — the card's NAME, one pad inside the box's top-right
    corner (so it lines up with the text under it on both edges), hidden until
    the pointer is inside the card. The annotation family's.

  **The union is still closed at two, and a FOOT is not a third seat.** Both
  seats float over the content and reserve no space, which is what makes "exactly
  one" the right rule for them and what `page-editor:anchor-has-decoration` pins.
  A foot reserves space and moves the card's padding, so it is a separate field a
  container may declare *as well as* its one decoration — see *Container frames*
  above.

  The corner seat needs a hover signal a frame cannot give: the frame is a grid
  SIBLING of its rows, so no ancestor holds both and `group-hover` has nothing to
  travel up. `internal/frame-hover.ts` is that signal — a scoped store the rows
  write on pointer-enter and only the decorations read, so a pointer crossing a
  long page re-renders no row. `read-only-view` nests through real wrappers and
  reveals with a plain `group/frame` instead; one component reads both.
- **An anchor row renders no rail *of its own* — because the rail on its borrowed
  line is already the container's.** The slots coincide with the first child's, on
  the same visual line, so there is exactly one rail there and `RailSeat.owner`
  resolves it to the outermost borrowing container: `+`, drag and the actions menu
  act on the container, not on the child. A second rail here would also register a
  second dnd-kit draggable under the same `drag:<id>`. The decoration is appearance
  and its own click surface, nothing structural.

### The rail's menu dispatches by owner

`BlockActionsMenu` is the ONE rail popover and has two arms, chosen by a **core**
fact about the seat's owner — `BlockHandle.anchor`, never by whether a plugin
contributed sections:

- ordinary owner → *Turn into* (+ the `Editor.TurnInto` contributions with no
  `from`, or `from` its type) + *Delete*;
- **container** owner → its `BlockFrameMeta.menu` sections, then a *Turn into*
  holding ONLY the `Editor.TurnInto` contributions declared `from` its type (no
  section when there are none), then *Collapse/Expand*
  (`RailSeat.owner.childCount > 1`), *Remove `<label>`* (`unwrapBlock`), *Delete*.
  No block-type list: a void container owns no text, so a type conversion has
  nowhere to put its children — a target written for the container's type knows
  where they go (the agent card's *Agent page*: its first line becomes the
  title, via turn-into-page's `title: { fromFirstChild: true }`).

Both structural halves are **generic**: `Remove callout` derives its wording from
`handle.label`, so a new container type wires nothing here. `menu` is a second
field on the same `Editor.BlockFrame` registration as the decoration
(`useBlockFrameMenus` is `useBlockDecorations`' twin), reusing `Editor.TurnInto`'s
contribution prop shape so "menu sections contributed by a plugin" is one
convention. A container's appearance renders in **both** the decoration's popover
and this menu, deliberately — the rail is where a user looks for block actions,
the decoration is where they look for the decoration.

`BlockHandle.anchor` is a **core** fact because the reducer needs it (`BlockOpContext.anchorTypes`
drives the split/merge refusals and the childless-anchor prune) and the server has
no slots; the *component* is a web contribution. `page-editor:anchor-has-decoration`
fails a handle that declares one without the other.

Escaping the box is `unwrap` (`core/block-ops.ts`): Backspace at the start of an
anchor's first child dissolves the container and promotes its children into its
slot. The generic `isIndented` → outdent rung would instead move that child
*below* the rest of the box (see below: out of a container, an outdent adopts
nothing and lands after the box).

**An outdent never splits a container.** `outdentOne` adopts a block's followers
(Notion's outdent) — except when its parent is an anchor: a container's children
are the box's content, not a subtree of the line above them, and adopting them
would carry them out of the box under the escaping line, which paints as the box
cut in two around it. So out of a container the block lands right after the box
and its followers stay inside. Every outdent path (empty-Enter, Shift+Tab, the
bulk selection outdent) goes through it, so none of them can split a box.

**Empty-Enter leaves a container only where its flow ends.** On an empty line
whose parent is an anchor, the ladder's outdent rung fires only for the box's
LAST line below at least one other (Enter, Enter at the end of a callout steps
out; `/callout` + Enter on a fresh empty line does not dissolve the box), for
every block type. Anywhere else in the box the outdent rung is skipped: the
type escape (`breakOutOnEmptyEnter`) still applies, then an ordinary split mints
another line inside the box.

### A container folds to its borrowed line

> A collapsed container renders exactly its first visible LINE and nothing else.

`visibleChildRule` (`core/block-ops.ts`) is the one statement of it, in two
rules — **R1**: an anchor always descends into its first child, collapsed or not
(its own line IS that child's); **R2**: the borrowed line of a collapsed anchor
shows no children and no following siblings. So folding a container is the same
rule every ordinary block follows ("hide everything below my own line"), and
nothing on screen moves when it folds.

The consequence that retired `collapsible: "never"`: **a collapsed container
always paints one line**, so content can never hide behind nothing — whatever a
hand-written `PATCH` or a pasted `SerializedBlock` sets `expanded` to.

- **Two encodings, one rule.** `visibleChildRule` returns the answer only;
  `visibleChildrenOf` resolves it over the flat array (reducer, ladders) and
  `flattenVisible` over the already-built tree (surface, so a render costs no
  per-node `childrenOf` scan). `flatten-blocks.test.ts` cross-checks them over a
  fuzz forest — a drift is the editor showing lines the ladders think are hidden.
- **The chevron rides on the borrowed line's ROW, and targets the container**
  (`resolveRailSeats`). It cannot live in the anchor's own row: gutter controls
  are `pointer-events-none` until their row is hovered and an anchor row is
  zero-height, so nothing could ever reveal it — collapse would be unreachable
  while expanded. There is exactly one slot on that line (the span rule seats a
  container and its subtree at one `left`), and it is the ONE rail control not
  unconditionally the seat's `owner`, allocated: a *collapsed*
  container claims it (the way back out, and the row's own state would lie);
  else the line's own block if it needs one — load-bearing for
  `collapsible: "always"` types, where the chevron drives the page MOUNT, not a
  fold; else an expanded container with 2+ children. Nested containers share one
  borrowed line, so only the outermost claims it; the rest fold from the rail
  popover's own Collapse item.
- **Content lands where it can be seen.** `applySplit` opens the containers it
  writes into (`revealAround`) — it was the one op that did not, and the tail
  landed among the folded children with no row and no Lexical instance while the
  executor had already truncated the origin's doc, so the text after the caret
  vanished. `applyInsert`/`applyPaste`/`applyMove` already opened their
  destination parent, as do both server move handlers.
- **You cannot restructure what you cannot see.** On a collapsed container's
  borrowed line, Backspace-at-start and Shift+Tab resolve to `{type:"expand"}`
  instead of `unwrap`/`outdent` — both would otherwise act on the hidden lines
  (spilling them into the document, or adopting them as the escaping block's
  children). One structural level per press, as empty-Enter's ladder already does.
- **A block is born expanded.** Every creation path mints `expanded: true`
  (unobservable — new blocks are childless), so a collapsed row is provably the
  user's own act. Hygiene, not the safety mechanism: the guarantee is the line
  a collapsed container always paints.
- **Read-only surfaces ignore the fold** (`read-only-view` never reads
  `expanded`), as do markdown, copy/paste and search indexing. Collapse is
  editing-surface view state — so the editor and the version-history *diff*
  deliberately disagree about what the document shows.

## A block id has one mint (`newBlockId`)

`core/block-id.ts` declares the block id kind (`blockIdKind`, `plugins/ids`,
shape `uuid`) and mints every `page_blocks` id, as `block-<uuid>` — the client
before the round trip (`insert`/`split`'s `newId`, `wrapInContainer`,
`withMintedIds`), the server for a row no editor is open on (`createBlock`,
turn-into-page's seed child). `page-editor/no-adhoc-block-id` keeps it one mint.

**An id is opaque everywhere except the kind** — recognised (the active-data
chip reads `blockIdKind.pattern`), never destructured. Rows predating `newBlockId()` keep bare-uuid ids (a backfill is a
migration: two self-FKs plus every `page_blocks_ext_*` table reference them), and
**undo of a delete re-inserts a row under its ORIGINAL id**, so a legacy-shaped
id reaches an INSERT on a live path.

## A page's structural writes are one ordered stream over one locked forest

Two invariants, deliberately not conflated. **A is per-page and server-side; B is
per-writer and client-side.** Between two *different* writers (a second tab, an
MCP writer) no causal order exists, so B has nothing to preserve there — A is the
complete and correct answer, and that is a design fact, not a residual gap.
Design: [`research/2026-08-01-page-structural-write-contract.md`](../../../../research/2026-08-01-page-structural-write-contract.md).

### A — atomicity (server)

> A structural write to a page's forest reads and writes it inside ONE
> transaction holding that page's lock. There is no way to write `page_blocks`
> without one.

`withPageForest(scopes, fn)` (`server/internal/page-forest.ts`) is the only
producer of a `PageForestTx`, and every export of
`server/internal/forest-writer.ts` — the only module allowed to mutate
`_blocks` — requires one. So an unlocked write is a **tsc error**, and importing
`_blocks` to route around the helpers is a **lint error**
(`page-editor/no-adhoc-forest-write`). Two halves; neither is sufficient.

- **`ctx.forest()` is the only read**, and it is lazy — which is what makes "the
  read happened under the lock" true by construction, and lets a delete/purge
  spanning many pages pay for no forest it never reads.
- **Locks are taken in sorted key order** over a deduped set as the transaction's
  first statements. That is the deadlock proof for multi-page writers (a
  cross-page move, a subtree delete spanning sub-pages), not a style choice.
- **A scope is `string | null`**; `null` is the workspace root, a real sibling
  space with its own live unique index, so it cannot be a hole callers fall
  through.
- **`ctx.afterCommit(cb)`** is where notify fan-out, reindex and re-push go —
  never inside, which would stretch the lock and await the pool from inside a
  transaction (`database/no-pool-await-in-transaction`).
- **Rank parking is unconditional** in `writeForestTarget`, not per-op: any diff
  that permutes `(parent_id, rank)` among siblings transiently duplicates a pair
  mid-loop, and the index is per-tuple and not deferrable. `pairChanged` filters
  it, so ops that permute nothing pay nothing.
- **A delete set is never hard-deleted by the writer** — see *Every block delete
  is a trash* below. `BlockLifecycle.OnTrash(rows)` runs after commit over the
  AUTHORITATIVE set the writer flagged (closed under descendants over the forest
  AS WRITTEN, under the lock, and flagged before anything is placed);
  `BlockLifecycle.OnDelete(rows, tx)` fires inside the lock only from purge,
  the one path that really hard-deletes.
  `rows` is authoritative in both, so a hook answers "which of these were pages"
  with `row.type` — no DB round-trip, nothing predicted. Anything an `OnDelete`
  hook needs pre-delete it reads on `tx`.

### The context both runtimes must agree on

`applyBlockOp` takes a `BlockOpContext` carrying the type facts the forest cannot
supply — which types are container anchors, and which carry text. The client
predicts the forest with it and the server commits with it, so a disagreement
makes an op apply differently on each side and never confirm.

That parity is **structural, not conventional**: both sides mint the context from
their own registry through the one shared `blockOpContextOf(handles)`
(`core/block-ops.ts`) — `useBlockOpContext()` on the web, `blockOpCtx()` in
`handle-apply-block-op.ts`. The registries differ; the derivation cannot. Every
seam in between passes the CONTEXT rather than a bare `anchorTypes` set, which is
what makes a new reducer fact one field instead of one parameter on each of six
signatures — and the reason `textBearingTypes` reached both sides at once.

`defaultTextType` (the plain paragraph, for `splice`) is the third fact, derived
the same way — `handles.find(h => h.defaultText)?.type` — so the reducer still
names no block type.

One asymmetry worth knowing: an ABSENT `textBearingTypes` means *no opinion*, not
*nothing accepts text*. The empty-set default that is right for `anchorTypes`
would refuse every merge on the page, so the refusal gates on presence and a
context-free caller gets the pre-context behaviour.

### B — order (client)

> One writer's structural mutations reach the server in the order it issued them.

Not a page-editor property: `optimistic-mutation`'s model is
`data = pendingOps.reduce(apply, serverTruth)`, an **ordered fold**, so ops that
don't commute need the server to apply them in issue order or truth diverges from
the prediction forever. Ordering therefore lives in that primitive's per
`(resource, params)` **send lane**, not in a ref here (a per-consumer chain
ordered each mount against itself only). See its CLAUDE.md.

The editor's whole job is to have **one way onto that lane**: every structural
mutation is a `BlockOp` (or the undo/redo `BlockPatch`) dispatched through
`BlockStore.dispatch`, so `web/block-store.ts` and the composite router are the
only callers of `applyBlockOpEndpoint` / `patchBlocks` —
`page-editor/no-adhoc-structural-write` makes a third one a build failure. The
two writes with no overlay to carry them (the detached persist into a collapsed
sub-page, and a cross-page drag) use `enqueueDetachedWrite`, which is the same
lane without a prediction — and reports a rejection like an overlay op's.

### A rejected write unwinds its undo entry

When the server PERMANENTLY rejects a write (a 4xx — `classifyRejection` in
`optimistic-mutation`), the primitive drops the op and the user gets an error
toast plus a report (`reports/optimistic-rejection`). The undo entry recorded
with it would bracket a change that never happened, so it is dropped too:
every recording chokepoint (`dispatchOp`, `applyOverlay`, the splice, the
mounted merge, `commitRows`) mints an entry id (`newHistoryEntryId`, undo-redo), records under it
and dispatches with `onRejected = dropRejectedEntry(id)` (`SettledBlockStore.dispatch`'s
second argument, threaded through the composite store, and carried by the
detached writes). A coalescing entry gets no id — one rejection must not drop
the steps that merged into it and did land.

## The caret authority (input follows the model, not the DOM)

> The editor holds ONE authoritative caret location. It moves synchronously with
> the keystroke that moves it. DOM focus is a PROJECTION of it — never the source
> of truth, never consulted to decide where input goes.

`internal/caret-authority.ts` owns that location AND the `BlockFocusHandle`
registry. **The registry is deliberately unreachable from the provider**: there
is no way to focus a block except `land()`, so the gap below cannot be
reintroduced by a future caller. (`surgeryOf()` hands back only
`BlockTextSurgery` — no `focus` — for split/merge content edits.)

The gap: a block created by Enter does not exist yet, so the caret used to land
only when its editor's **passive** effect registered a handle — a separate React
scheduler task — while keydowns arrive from the browser's higher-priority
user-interaction source. Every keystroke in between went to the ORIGIN, already
truncated, caret at the cut point: "alpha" Enter "bravo" → `["alphab","ravo"]`.
Nothing bounded that window; human typing speed just usually won the race.

- **Two states.** *idle* — model and DOM agree, the authority does nothing and the
  browser types natively (which is what keeps IME/dictation/autocorrect working:
  they need a real editing host). *in flight* — the model moved, the DOM hasn't;
  the authority owns the keyboard.
- **The caret parks on the container, it does not defend the origin.** A claim
  does `container.focus()` + `releaseCaret`, so the origin stops being an editing
  host and nothing can enter it BY CONSTRUCTION. `preventDefault` would not be
  airtight — `beforeinput` with `insertCompositionText` is not cancelable.
  Consequence: `beforeinput` never fires during a flight (there is no editing
  host), so buffered text comes off **`keydown`** (`key.length === 1`) plus a
  `paste` capture; `ctrl`/`meta` keydowns pass through untouched.
- **A burst of mutations in one turn needs ordering the old code got for free.**
  Replay issues structural mutations back-to-back with no React commit and no
  pause between them. Two of the three assumptions that broke are now the
  enforced invariants A and B of *One ordered stream over one locked forest*
  below; the third is local here: `rowsRef` is ADVANCED at each mutation
  chokepoint (`advanceRows`), not only by the consumer effect — otherwise two
  mutations in one turn both snapshot the pre-first-mutation rows and the second
  reasserts the first's columns.
- **KNOWN BOUND: composition input started inside the flight window is DROPPED.**
  A dead key or IME keydown carries no character (`key` is `"Dead"`/`"Process"`),
  and with no editing host there is nothing to compose into, so it is neither
  buffered nor replayed. It is the price of the line above and strictly better
  than the alternative — before, those characters composed into the WRONG block —
  but it IS a loss, bounded to the mount gap (typically one commit); IME is
  untouched once the caret has landed, and completely untouched while idle. The
  fix, if it ever matters, is to shorten the window (`flushSync` + a layout-effect
  registration), NOT to make the container an editing host.
- **Landing waits for caret-READY, not for the mount.** A freshly split block's
  Lexical root is childless until the collab pre-seed lands, and there is nothing
  to insert into until then. `CaretLandOptions.onLanded` is that signal;
  `focusHydratingAware` fires it on both branches. A landing policy that takes the
  caret and never reports back leaves the authority holding the keyboard —
  **so a landing RESOLVES, one way or the other**. `onLandingLost` is the failure
  dual (focus moved off the root before content arrived → abort
  `landing-focus-lost`). Neither authority bound covers it: `focusout` only sees
  focus leave the block LIST (a steal onto another block, or onto `<body>` with a
  `null` `relatedTarget`, is invisible), and `reconcile` only counts commits
  rendering no line for a target that IS rendered.
- **Replay must be INDISTINGUISHABLE from typing**, and that is four rules, each
  paid for by a shipped bug (`replayInput` in block-text-editor):
  - **One character per commit** — never coalesce a text run. The block markdown
    shortcut fires on the `"- "` transition and the inline one demands
    exactly-one-char-typed, so a coalesced `insertText` skips every incremental
    transform: `"- Bravo bullet"` stayed a paragraph and the next Enter inherited
    `text`. The Yjs cost coalescing avoided does not exist (the run tracker's
    500ms idle window folds a run into one undo entry either way).
  - **`discrete: true` on every replayed edit** — Lexical's default commit is a
    microtask, so the next entry would resolve against pre-insert state: offset 0,
    empty runs, a split at `position: 0` whose `truncateAt(0)` wipes the doc
    (`["alpha","","charlie"]`).
  - **One microtask yield per entry** — the editor DEFERS work by `queueMicrotask`
    (the markdown conversion, split's doc-edit capture, inline autoformat) and a
    real keystroke sequence lets it run between keys. Replaying a whole buffer
    inside one microtask starves it. Microtasks drain before the next input event,
    so this cannot let the user overtake the buffer.
  - **Unconsumed keys need their DEFAULT ACTION applied** — `dispatchCommand` is
    not a DOM event and a synthetic `KeyboardEvent` is untrusted, so nothing runs
    when no listener consumes it. Lexical's own listeners cover Enter / Backspace /
    Delete, but ordinary caret movement is the BROWSER's: five buffered ArrowLefts
    silently did nothing, so the following Enter split at the end instead of
    mid-word. `selection.modify` replays Left/Right; an unconsumed Up/Down (a move
    between visual lines, which has no model equivalent) is dropped — a caret
    position, never content.

  A replayed Enter re-enters `split()` and claims the NEXT flight, so the "alpha
  Enter bravo" composition needs no special case.
- **Typing over a text span claims too** (`landWithInput`): the key that replaced
  the span reached the CONTAINER, so it is routed input with no editing host —
  a flight whose buffer starts with it, to an EXISTING block. It always claims,
  mounted target or not; the landing is bounded like any flight's.
- **Only a block that does not exist yet is claimed** (by `land`). A block that exists but has
  no mounted handle (a void row, a collapsed-away editor) is queued best-effort
  WITHOUT taking the keyboard: the caret never moved off the origin, and claiming
  for a landing that may never come would strand the user's typing.
- **Failure is a state.** The flight is bounded PUSH-BASED (`reconcile` on every
  commit, never a timer) and by focus leaving the surface. On abort the buffer
  replays into the ORIGIN and one `caretFlightReportSink` report is emitted
  (consumer: `reports/plugins/caret-flight` → Debug → Reports); a handle without
  `replayInput` aborts loudly rather than eating the keystrokes.
  The bound's driving relation is the **RENDERED line set** (`flatOrderRef`) —
  NOT `serverIds` (under never-revert a split's block renders long before any
  push confirms it, so that would abort every normal split), and not merely "the
  row exists" (a row nothing renders — a collapsed ancestor — mounts no editor,
  so the landing can never happen and the keyboard would hang undiagnosed).

**Replay must commit `discrete`, and must not begin inside an update.** Each
replayed insert is committed synchronously (`discrete: true`) because the next
replayed key resolves against `getEditorState()` — Lexical's default microtask
commit would have it read the PRE-insert state, resolve "empty block", and split
with `position: 0, runs: []`, whose `truncateAt(0)` wipes the doc (this shipped
once: `["alpha","","charlie"]`). `discrete` is only honored outside an enclosing
update, and a landing can fire from inside one, so `replayInto` defers the whole
loop one microtask — which cannot let the user overtake the buffer, since
microtasks drain before the next input event.

**Two guardrails, and neither subsumes the other.**
`web/__tests__/caret-authority.test.tsx` is the only place the long window is
deterministic (withhold the target's handle) — it pins routing, ordering, the
flight hand-off and the abort path. It CANNOT model Lexical's commit timing: its
fake handles have no editor state, so the `discrete` defect above passed there
and was caught only by `e2e/split-typing-verify.ts` in a real browser. Anything
about *when* an edit becomes visible to the next one belongs in the e2e. Design:
[`research/2026-07-31-page-caret-authority.md`](../../../../research/2026-07-31-page-caret-authority.md).

## The caret does not stop at the editor's edge (`CaretSurface`)

The title sits above the block list, outside the provider, yet the caret must flow
across that seam the way it flows between two blocks — ArrowUp / ArrowLeft /
Backspace at the top of the body land in the title, Enter / ArrowDown /
ArrowRight in the title land in the body (Notion's model).

The seam is one contract, `web/caret-surface.ts`:

```ts
interface CaretSurface {
  focus(): void;                                     // required
  focusBoundary?(edge: "start" | "end"): void;       // land at my very start/end
  focusAtColumn?(x: number, edge: "top" | "bottom"): void;  // preserve the pixel column
}
```

Implementing it is all that is needed to participate: blocks (`BlockFocusHandle`,
which widens it with `focusOffset`/`truncateAt`/`appendRunsAtEnd`), the block list
(`BlockEditorHandle`, the host-facing ref), and host chrome (the page title over an
`<input>`, handed to `<BlockEditor caretBefore>`; `caretAfter` exists symmetrically,
unused). A host passing neither gets the caret's terminal landing instead: a
horizontal arrow does nothing (at the very last character there is no next
character), while a vertical one collapses the caret to that block's own far edge
— `landCaretAtOwnEdge`, i.e. ArrowDown on the last line lands at the end of the
text, the way a textarea and an `<input>` do.

Three rules keep this from leaking:

- **`landCaret` is the one landing policy** (`internal/caret-landing.ts`): vertical
  crossings preserve the pixel column *when the surface can honor it*, horizontal
  crossings land on the boundary they were travelling toward, and a surface
  offering neither refinement just takes `focus()`. `navigate()` calls it with the
  same arguments for blocks and host chrome, never branching — so a one-line
  surface merely omits `focusAtColumn`, with no special case anywhere.
- **`focus()` restores, it does not place** (`focusRestoringSelection`): an editor
  already holding a caret keeps it exactly where it is, and only a selection-less
  one is landed at its content start. Otherwise every re-focus of the block the
  user is standing in — `Tab`/`Shift+Tab`, whose executors call `focusBlock` —
  becomes a caret-to-start keystroke. **A caller wanting a specific position says
  so** (`focusBoundary(edge)` / `focusOffset(n)`), which is why the
  empty-background click goes through `focusBlockBoundary` in all three branches
  rather than leaning on a side effect of `focus()`. Spec:
  `e2e/indent-caret-verify.ts`.
- **`resolveKeystroke` never learns about the boundary.** Backspace at the start of
  the first top-level block has no block to merge into, so it resolves to what
  ArrowLeft resolves to there — `{ type: "nav", dir: "left" }`. Whether a surface
  waits on the other side is the executor's business, which is why "Backspace goes
  back to the title" needed no new intent, op, or resolver branch.

## A void block has no caret to see (`web/components/void-caret.tsx`)

A **void** block owns no editable text — a divider, an image, a bookmark card, a
sub-page row, the source of an equation or a code block. Two things follow.

**There is no blinking caret to look at**, so something has to say where the
caret is.

**And nothing registers a focus handle for it.** `navigate()` walks the
registered handles, so a block with none is *skipped entirely* by arrow keys
while a click can still focus it — the caret jumps over a block the user can
plainly see. That was the state of **eight block types at once**: image, video,
audio, file, embed, bookmark, place and page-link registered nothing, and nothing
anywhere could tell them, because forgetting to declare looked exactly like a
block with nothing to declare.

So the fix is not "call the hook eight more times". It is that **the editor
mounts the caret host, and the registration has to say who holds the caret.**

### Two answers, and no way to give none

`Editor.Block`'s text-less arm requires

```ts
caret: "editor" | "renderer"
```

- **`"editor"`** — `BlockRow` wraps the block's dispatch in `BlockCaretHost`. The
  block writes *no caret code at all*: focusability, the cue, ↑/↓, Escape,
  Backspace and Enter all come from the host. This is the answer for every block
  whose payload is an object the user looks at rather than types into.
- **`"renderer"`** — the block registers its own handle with `useVoidCaret`,
  because only it knows what must hold the caret: a `<textarea>` of source
  (`code-block`, `equation`), or a `Row`'s inner control, which `Row`
  re-synthesizes the moment the row grows actions (`sub-page`).

There is deliberately **no third value meaning "nowhere"** — that state is what
the eight types were in. A type with no registration at all (the `unknown`
fallback) falls into the `"editor"` arm, which is the fail-safe direction the
type system cannot reach.

A **container anchor** gets its own arm, on which `caret` is `never`: it renders
no line, so `BlockRow` returns before the dispatch and there is nothing for a
caret to land on. The proof is `defineContainerBlock`'s return type, which states
`anchor: true` as a certainty — the handle's own field is `anchor?: true`, which
no amount of setting by hand can narrow. Anchorhood was already "you went through
that factory"; this makes it provable to a type rather than only to a reader,
which is why there is no check pinning the two together.

| block | what shows the caret |
| --- | --- |
| text-bearing | the real blinking caret — the editor draws nothing |
| `caret: "editor"` (media, `divider`, `unknown`) | `BlockCaretHost`, mounted by the row |
| `caret: "renderer"` owning a text control (`code-block`, `equation`) | the textarea's own caret; the block owes only `useVoidCaret` |
| `caret: "renderer"` delegating to a control with its own "current" vocabulary (`sub-page`) | `Row`'s `selected`, plus `useVoidCaret` |
| container anchor | its children's — it has no line |

### What the caret on a media block MEANS

> A media block is **one object in the document**. The caret on it means *this
> object is the current line*. It never means *you are inside it*.

Everything the host does is a consequence of that one sentence, and it is the
same sentence for all of them — an image and a bookmark differ in payload, not in
what the caret is doing there.

- **Focus lands on the host**, in every render state (empty, uploading,
  resolving, filled, error), never on an inner control.
- **The controls inside stay reachable**, and they report focus *upward* (React
  `onFocus` is `focusin`, which bubbles), so DOM focus and the editor's model can
  no longer come apart. That is why `AttachmentUpload`'s `onArm` prop and
  `PlaceSearch`'s `onFocus` prop are gone: they were hand-reporting what now
  bubbles.
- **Backspace/Delete removes the block in one press**, whatever the payload
  holds. A filled image is ONE object, not content to clear and then a block to
  delete. *Clearing* the payload is what the block's own Remove/Replace button is
  for — two affordances, two meanings, deliberately. The caret lands above, which
  is where the user's line then is, so a Backspace arriving from the block below
  reads as one continuous motion.
- **Enter means "keep going"**, and which one depends on the state: an *unfilled*
  block is a prompt asking for a payload, so Enter fills it (open the file
  picker, focus the URL box, open the page picker); a *filled* one is an object,
  so Enter starts a paragraph below. That per-state answer is registered from
  inside the component with **`useBlockActivate(fn | null)`** rather than
  declared beside `caret`, because it depends on state a registration cannot see
  (a hidden `<input>`'s ref, which arm rendered). Registering `null` is a
  legitimate state, not a failure. Outside a host the hook is a documented no-op:
  `AttachmentUpload` is shared, and its callers should not have to know which
  surface they are on.
- **Escape enters block-selection mode.** A text block reaches it through
  Lexical's own listener; the host has no Lexical, and its Backspace deletes
  rather than selects, so without this there would be no keyboard route into a
  multi-block selection containing a media block at all.

The paragraph Enter seeds comes from the registry's own `defaultText` flag
(`useInsertParagraphBelow`), so the editor still names no block type — no
editor↔text cycle, and the divider's hand-rolled `textBlock.schema.parse` seed is
gone.

### Escapes are unconditional; meanings are the host's own

Getting this split wrong strands the caret, so it is worth stating twice. A
single origin guard (`e.target === e.currentTarget`, the discipline the
block-selection container uses) would mean that once focus is on any inner
control — the upload dropzone, a URL field, a link — ↑/↓ reach nothing and the
user cannot leave the block by keyboard at all.

- **↑/↓ and Escape run wherever they originated**, subject only to
  `defaultPrevented`. That is the protocol: an inner control that genuinely wants
  the arrows says so by preventing default, which is exactly what the place
  block's result list already does while its suggestions are open.
- **Backspace/Delete/Enter/Space are origin-guarded**, so typing in an inner
  field is never swallowed by the block around it.

`useCaretEscape(editor)` is the ↑/↓ half on its own, for the `"renderer"` blocks
that need it. It is a separate export rather than a field on `useVoidCaret`'s
result because the textarea types must NOT take it — their arrows move through
their own source — and "don't spread that field" is a discipline, whereas "don't
call that hook" is a spelling.

### Focus: three rules, three different questions

`useVoidCaret` answers *"the model moved, so move the DOM"*, and it deliberately
carries **no "is it already the focused element?" guard** — `.focus()` on the
already-focused element fires no event and moves no caret, so the guard bought
nothing, and it is unspellable against a capability anyway.

Wrapping INTERACTIVE content made two more questions askable that a divider never
had to answer, and `BlockCaretHost` owns both:

1. **Focus is already inside me.** Clicking "Remove image" focuses the button,
   which bubbles, which makes this the current block, which flips `isFocused` —
   and the pull would yank focus off the button the user just clicked. So the
   capability declines when `contains(document.activeElement)`. This is a
   CONTAINMENT question, not an identity one. It **cannot see through a portal**,
   and nothing here can: a popover rendered to `document.body` is not a
   descendant. That is why `page-link`'s picker opens from its `useBlockActivate`
   instead of auto-opening on mount — an auto-open would race this and lose.
2. **Focus went nowhere.** The block's own control can unmount under the user's
   feet ("Remove image" clears the payload, so the focused button disappears and
   focus falls to `<body>`). `isFocused` never changed, so rule 1 never re-runs,
   and the model says the caret is here while the keyboard is nowhere. So focus
   is reclaimed on every commit — but ONLY from `null` / `<body>`. Not "anywhere
   outside this row": that would steal from a portal, i.e. rule 1's blind spot
   arriving by a different road.

### The cue is two conditions that LAYER, not one replacing the other

`BlockCaretHost` writes:

```tsx
className={cn("focus-ring cursor-default rounded-md", isFocused && "bg-accent")}
```

- `focus-ring` answers *"does this element have DOM keyboard focus?"*. It is the
  app's canonical indicator, and it is the same utility that suppresses the
  browser's own outline — so the replacement is drawn on **exactly the condition
  the original was suppressed for**.
- `bg-accent` answers *"is the editor's caret on this block?"*. It is the tint
  `Row.selected` paints, which is why `sub-page` (a `Row`) and every hosted block
  say the same thing the same way; `sub-page` passes `hover="accent"` for
  precisely that reason. It is also a different hue from the block-SELECTION band
  (`bg-primary/15`), which is the app's existing two-cue language rather than a
  coincidence.

That separation is a fix, not a style choice. The divider used to write
`outline-none` unconditionally and then draw `ring-primary/30 ring-1` on
`isFocused` — a *different* condition. A box that had genuinely taken keyboard
focus while the editor's model disagreed therefore showed **nothing at all**: the
browser's indicator was off and the replacement never fired.

`page-editor/no-model-focus-ring` (in this plugin's `lint/`) is the rung that
keeps it fixed: a focus/ring/outline class inside a class expression gated on
`isFocused` is an error, wherever it is written. The rule has no path exemption —
the host writes the focus utility *unconditionally* and puts only the tint under
the gate, so the definition site does not trip. If it ever did, that would be the
signal.

### The host adds no padding, and it counts as row background

It sits at the row's content-left edge `C`, which is where *The page column* puts
a block DECORATION — and the caret cue is one. Every block keeps its own
`<Inset x={BLOCK_INSET}>` for its content.

Because it is full-width, a press on the empty strip beside a 480px image lands
on the host rather than on the row, which would otherwise stop the whole margin
of every media row from being background: no marquee could start there. So the
host carries `data-caret-host` and `block-editor.tsx`'s `onPointerDown` treats a
press on the host ITSELF as a press on the row. A press on the block's real
content still hits a descendant and is still content.

One consequence worth knowing: a margin click used to *select* a media block
(`onEmptyClick` fell through to `applyRange` for a row with no focus handle) and
now *focuses* it, and the click's edge (`start`/`end`) is ignored, because a void
handle has no `focusBoundary` — a void block is ONE position, with no start or
end to distinguish. Selecting it is one Escape away.

A void handle registers `focus` only. It omits `replayInput`, and
`internal/caret-authority.ts`'s `landFlight` keys its void arm on exactly that
absence — so a landing on a void block resolves with no `onLanded` plumbing on
the block's side.

### What a media block still cannot do: carry a caption

None of them has one, and a caption cannot simply be a `caption` string in the
payload. `handle.acceptsText` is DERIVED from `"text" in schema.shape`, and it
decides which arm of `BlockRegistration` the type lands on, whether the shared
text renderer is forced on it, and whether the Backspace/Delete ladders will
merge INTO it. A media type carrying text would be routed to `BlockTextRenderer`
and would start absorbing the paragraph above it. The shape that works is a child
text block, which also gets the real Lexical caret, marks, links, collab and
undo — a separate change.

## Caret geometry is stated in LINE BOXES (`internal/caret-geometry.ts`)

"Is the caret on the first / last **visual** line" (which decides whether an arrow
moves within the block or crosses to the next one) and "place the caret at pixel
column *x*" are both answered by comparing **line boxes** — never the caret's *y*
against the contenteditable's padded box. A block's soft lines are `<br>`-separated
runs inside one `<p>`, and a collapsed `Range` paints **nothing** on an empty soft
line or beside an inline decorator, so anything derived from the root's box is a
guess. Rules that look redundant but are not:

- **Every rect read returns a real box or `null`; `null` degrades to the STRUCTURAL
  edges**, never to `onTopLine/onBottomLine = true` (which would claim the caret is
  on both edges of a multi-line block at once).
- **Unmeasurable positions borrow the box of the child at the anchor offset** — the
  `<br>` forming the empty line, the chip the caret stands before. That child is
  always on the caret's own line.
- **`edgeLineRect` walks leaves INWARD from the edge**, so an unmeasurable trailing
  leaf hands off to the leaf before it. Climbing to the parent instead returns a box
  spanning every line at once. A `<br>` has no client rects but does have a bounding
  box — that fallback is the last line of any block ending in a blank line.
- **A hit-test's `(element, childOffset)` is translated to a Lexical child index**;
  element offset 0 would land every hit on the block's first line. A hit resolving to
  the RootNode, a `LineBreakNode` or a **decorator** lands *beside* it — an
  element-typed point on a decorator is a caret the browser cannot paint.
- **`caretLineRect` is exported, and the pending-marks cue anchors to it** — so the
  chip and the arrow-key line logic answer "where is the caret" with the same read
  rather than the cue taking a weaker one. The borrowing branches are what it buys:
  on an empty soft line and beside an inline chip the chip sits on the caret's line,
  and the editor-root fallback is last-resort rather than the common empty case.
- **The guarded selection read is not this module's.** `getSelection()` →
  `rangeCount` → `getRangeAt(0)` (which throws `IndexSizeError`) is `selectionRange()`
  from `@plugins/primitives/plugins/dom/plugins/dom-selection/web`, enforced by
  `no-raw-selection-range`; `hasBox` from the same barrel is what `usable()` states.
  Ranges this module CONSTRUCTS (`nodeLineRect`) involve no document selection and
  are untouched.

Spec: `e2e/soft-line-caret-verify.ts`. Crossing a decorator sideways belongs to
`primitives/text-editor/decorator-nav` (mounted by both Lexical hosts), not here.

## A mark boundary is a caret position (the virtual delimiter)

> Every inline-mark boundary holds one INVISIBLE ONE-CHARACTER DELIMITER.
> Rendering is unchanged; only the caret and the edit semantics pretend the
> character is there.

Marks are format **bits on a `TextNode`**, not nodes with edges — so at a
boundary the caret is one point with two meanings (inside the span, outside it)
and the DOM offers one. A block ending in a marked run therefore trapped the
caret: `offset === getTextContentSize()` was the last position that existed, and
plain text could never be typed after it. Not `decorator-nav`'s bug (a position
that exists but isn't painted); a position that does not exist. Design:
[`research/2026-08-06-page-inline-mark-boundary-caret.md`](../../../../research/2026-08-06-page-inline-mark-boundary-caret.md).

> **A boundary has TWO caret states, carrying the LEFT run's marks and the RIGHT
> run's. The browser hands you one of them (`natural`). The stop is THE OTHER
> ONE.**

- **One stop per boundary.** One press crosses the whole boundary; one Backspace
  deletes the whole boundary. `virtualStop()` returns the direction AND the marks
  from one branch, because they are one fact — which of the two states the caret
  is standing in. Do not split them again (see below).
- **A block edge is an empty unmarked neighbour.** That single modelling choice
  is what makes block-start, block-end and mid-block ONE code path — the boundary
  strip (`internal/mark-boundary.ts`) never asks which of the three it is.
- **The stop is a question about the LIVE anchor**, not about the boundary's
  shape. A text/text seam resolves to the END of the left run, so `natural = L`
  and **every** boundary gets a stop — mid-block ones included, one extra press
  each. That left bias is **not Chromium's** (as this file and the design doc
  both used to say): it is `resolveSelectionPointOnBoundary`
  (`lexical@0.44.0 Lexical.dev.mjs:7669-7677`), which rewrites a collapsed point
  at `offset === 0` whose previous sibling is a `TextNode` to that sibling's end,
  on every DOM→model resolution. Same observable, but a deterministic,
  cross-browser, version-pinned **library invariant** rather than a browser quirk
  that could flip — so `e2e/mark-boundary-verify.ts` phase 6a's "the bias has
  flipped" failure message describes something that cannot happen while that
  function exists. (`internal/mark-depth.ts`'s header carries the full citation
  chain; the same function is why depth cannot live in the document at all.) The
  design predicted the opposite (`` `zz`|plain `` would need none, since the
  plain run's own start already carries `{}`) and was wrong; consistent behavior
  everywhere is the trade, taken deliberately. Two things follow. The direction
  needed no change, because it asks the anchor instead of predicting the
  resolution — so a falsified assumption cost one test expectation, not a
  redesign; **keep it derived**. And **mid-block was broken before this feature
  too**: typing at `` `zz`|abc `` used to produce a `{code}`-marked character in
  a run the user is typing outside of.
- **`left ∩ right` is NOT the stop — it is the deletion's residual**, and this is
  the trap to not "fix" back. `L ∩ R` coincides with the real answer whenever the
  stop's side is a SUBSET of `natural`'s (every block edge, and the measured
  `` `zz`|plain `` seam), so it looks right and tests green. It fails silently at
  `` a|`zz` ``, where it computes `{}`, sees `natural` already carrying `{}`, and
  synthesizes NO stop: you can append to a code span but never prepend into one.
  `L ∩ R` is `delimiterDeletion().residual` — what both runs keep once the
  delimiter is deleted, hence the caret's marks afterwards.
- **The delimiter's deletion is split by SIDE** (`before` = `L \ R`, `after` =
  `R \ L`), walked outward from the seam's two leaves. A mark lives on exactly
  ONE side, so a single-direction walk from the anchor no-ops on the other's —
  at `` a|`zz` `` that is a Backspace consumed for no effect.
- **A block's own edge is a boundary too, and a horizontal CROSSING must meet the
  state facing the side it came from** — `markArriveFor`'s rule, one scope up.
  Which arrivals obey it is not a list anything here maintains; see *Every
  arrival is an announced crossing*.
- **Virtual positions, never real zero-width nodes** — but **not for the CRDT
  reason once written here, which is false**. ("Two peers at one boundary give
  two seams `coalesce` won't merge": `Item.integrate` ORDERS concurrent inserts
  rather than merging them, so two seams do appear — but a dedup rule stated over
  CONVERGED state is a pure function of the merged document, both peers compute
  the same answer, and Yjs deletes are idempotent tombstones. It converges in one
  round. Don't repeat it.)

  What actually rejects a real seam: (a) a caret-addressable character is a real
  character in the browser's text layer, so find-in-page stops matching across
  it, spellcheck and double-click word selection segment on it, and single-line
  `Cmd+C` is *deliberately* handed to the browser (`internal/transfer.ts`,
  `decideTransfer`'s `{kind:"inline"}` arm) so it reaches the system clipboard with
  no code of ours in the path; and (b) it is a character in the plain-text offset
  basis, which reaches a SERVER consumer —
  `$spliceRunsInto` (`core/runs-splice.ts`, called by
  `page/block-text-write/server/internal/block-doc-text.ts`) splices a block's
  `Y.Doc` from seam-free runs, so every agent write would delete every seam and
  every client re-mint them. A Lexical-only seam excluded from the Y doc is not
  available either: `CollabElementNode.syncChildrenFromYjs`
  (`@lexical/yjs@0.44.0 LexicalYjs.dev.mjs:529-540`) unconditionally
  `removeFromParent`s every Lexical child with no collab twin on every remote
  sync, and `SKIP_COLLAB_TAG` is exported by `lexical` but never read by
  `@lexical/yjs`.

### Every arrival is an announced crossing

> Every mover that relocates a caret **across** something announces the crossing
> on one channel, in the direction of travel. Every consumer of a virtual
> position observes that channel. **A crossing is declared by the mover that
> knows it happened — never inferred from a selection transition.**

The channel is `primitives/text-editor/caret-motion`; this editor's observer is
`internal/mark-arrival.ts`, mounted beside the depth store in
`keyboard-plugin.tsx` (both halves of the caret's second component in one place).
It is a Lexical command, not a registry, because a listener runs INLINE inside
the announcer's own update — so the observer reads the pending selection the
crossing just produced, which is what an arrival needs and what the observer used
to buy, back when it had one caller, with an `editor.update()` of its own.

Adding a virtual-position kind is one observer; adding a mover is one call. The
matrix collapses from `movers × kinds` to `movers + kinds`. Only the direction
travels — `markArrive` carries `dir`, never a mark set — so "which state does an
arrival land on" has exactly ONE implementation, reading the live anchor after
the placement. The three movers today: the step within a block (`markArrive`),
the cross-block landing (`CaretLandOptions.crossing`, the surface-level spelling
of the same announcement, because a `CaretSurface` has no Lexical editor), and
the step across an inline decorator. Nothing else announces, so a click, a focus
restore, a vertical crossing and every explicit placement land `natural`.

**The "never inferred" half is load-bearing.** A transition-derived rule ("did
the anchor cross a boundary?") cannot tell a one-character click from a
one-character arrow step, and `$placeCaretAtLinearOffset`'s merge landing looks
like a unit step too — it would arm the `escaped` gate for all three. `e2e`
phase 10e is the assertion that catches it.

### Depth is STORED, never derived from `selection.format`

The cheapest-looking design — "depth = the caret's format diverges from its
node's" — is **aliased by three shipped mechanisms**, each of which produces that
divergence with no escape step anywhere in the interaction:

1. **Every row of `FormatShortcutsPlugin`'s table** (not just the Cmd+E the e2e
   drives) fires on a collapsed caret by design, and Lexical's collapsed branch
   of `formatText` is a pure selection toggle — so Cmd+E at the end of a
   `` `xxxx` `` run yields `format = N \ {code}`, **bit-identical** to depth 1.
2. **`applyInlineFormat`** snapshots `preFormat` and restores it onto the
   post-transform caret, so **every** successful autoformat lands at `format = 0`
   on a marked node — the single most common path in the editor.
3. **Programmatic caret landings.** `TextNode.select()` leaves `format`
   untouched, `$placeCaretAtLinearOffset` deliberately resolves a boundary to the
   *end of the earlier leaf*, and `appendRunsAtJoin` focuses a selection-less
   editor at the end of a possibly-bold run.

Under a derived depth, each of those makes the user's next Backspace strip
formatting from a whole span instead of deleting a character — an invisible,
destructive edit on the undo stack. **This is the trap most likely to be
reintroduced**, because the derived version looks like it needs no state at all.

So `internal/mark-depth.ts` stores it: a `WeakMap<LexicalEditor, anchor>`
**written only by the `markStep` executor**, **read with verification** (it counts
only while the live selection is still collapsed at exactly that anchor; anything
else is depth 0), and **cleared on any update with dirty leaves** — its own key is
its invalidation. Lexical's format-divergence carry is a ~200 ms window keyed on
`(anchorKey, offset)`, not durable state, so `selection.format` is the **effect**
(what to type with), re-asserted from the store by a `SELECTION_CHANGE_COMMAND`
listener — never the encoding.

### The `escaped` gate is the safety property

Backspace's new rung sits at the **top** of the ladder, above the `atStart` guard
(the caret is at a run's *end*, so `atStart` is false and today's guard would
passthrough) — and fires **only when `caret.escaped`**, i.e. only after our own
arrow step in the same interaction. Delete gets the symmetric rung above its
`atEnd` guard.

> **The ladder below the new rung is unchanged.** Cmd+E, autoformat and merge
> landings all take the ordinary character deletion, and Backspace-at-start on a
> bold line still merges exactly as today.

`e2e/mark-boundary-verify.ts` is the executable statement: phase 4 is that gate,
one sub-case per aliasing mechanism above, and phase 1 is the feature itself — its
deliberate *settle before typing* is what makes it non-vacuous, since typing
inside Lexical's 200 ms window gives the same rows with no feature at all.

The unmark is a content mutation, so it lives in `inline-format-surgery.ts`
(`removeMarkSpan`) rather than a third near-identical surgery module: that file
already owns the leaf walks, the `hasFormat`-guarded `toggleFormat` idiom that
makes the runs round-trip correct by construction, and the defer-then-re-verify
contract a command listener needs. Wired through `recordDocEdit`, which runs it
inside the run tracker's `untracked` scope and records the doc's runs before and
after as its own data entry — **one Cmd+Z restores the mark and nothing else**.

### `MARK_ORDER` is a storage sort key, NOT a nesting order

Cap-at-1 dissolves the nesting question outright: the caret never stops between
two delimiters, so exit order is **unobservable** and nothing can drift. Do not
reach for one. Had it been observable it would have had to derive from
`wrappersOf` reversed (`core/inline-markdown.ts`) — `code, strikethrough, italic,
bold, underline` — which is deliberately *not* reverse `MARK_ORDER`.

### The one door not taken: marks as inline `ElementNode`s

The only alternative whose core claim survives scrutiny, recorded so the question
stays settled. `resolveSelectionPointOnBoundary`'s inline-`ElementNode` branch is
gated on `!isCollapsed` and so does **not** fire for a caret, while its
`$isTextNode(prevSibling)` branch does — so with marks as elements
`(rightLeaf, 0)` SURVIVES, both boundary states become stable Lexical addresses,
and the arrival problem closes outright (`selection.anchor` says which side you
are on, so `mark-depth.ts` and `mark-arrival.ts` both go). Convergence is solved:
an `ElementNode` maps to a nested `Y.XmlText`, which `LinkNode` proves here in
production.

Rejected because it buys that at the price of two. **There is no pending-mark
channel for elements** — Lexical's only one is `RangeSelection.format`, an
integer bitfield (`Lexical.dev.mjs:6011-6014`), so Cmd+B-then-type, the collapsed
toolbar state and "which side" all need a new side store: it trades the mark
store for a pending-mark store. And **nesting order becomes normative and
observable**, which cap-at-1 deliberately dissolved — with remote applies
committing `skipTransforms: true`, so a normalizing transform would not run for
them. Plus a hard CRDT cutover (every `page_block_docs` blob encodes `__format`).
~2 months. ProseMirror and Slate both keep marks as set-valued properties on text
for the first reason.

### Known bounds

- **A collapsed caret says what it will TYPE with, and only that.**
  `FormatToolbarPlugin` is the selection format surface in two
  mutually-exclusive presentations; the second is the cue — a chip under the
  caret reading its pending set (`plain`, `code`, `bold code`) *while the caret
  stands at a mark BOUNDARY (either of its two states), or while that set
  DIFFERS from the marks of the text it stands in*. The boundary arm is what
  makes a boundary's two states mutually distinguishable — `` `zz|` `` reads
  `code` and `` `zz`| `` reads `plain`, at one pixel and one linear offset —
  since "the two sides agree, so there is nothing remarkable to say" is the
  wrong test at exactly the position the feature exists to disambiguate. Its
  cost is the self-extinguishing half: typing INSIDE a marked run at a block
  edge KEEPS a chip on screen (the run's right neighbour is the empty unmarked
  void, so the caret is still on a seam). Typing plain text, and typing after
  stepping out, show nothing. Derived from `selection.format`, which does
  **not** contradict *Depth is STORED* above — **the store decides what a KEY
  does; `selection.format` decides what the SCREEN says.** Nothing here touches
  the store, so a chip for Cmd+E or an autoformat landing is the *point*, not a
  false positive. It says nothing about **Backspace** deliberately, and a step
  that changes neither arm stays invisible: right after `` `zz` `` autoformats
  (`preFormat` already left the caret at `{}`) the chip reads `plain` both
  before and after the ArrowRight out, and it is the ArrowLeft back INSIDE that
  reads `code` — `e2e/pending-marks-cue-verify.ts` phase 3 is that pair. It
  anchors to the caret's LINE box (`caretLineRect`), so it is correct on an empty
  soft line and beside an inline chip; the editor-root rect is a last resort for a
  block with nothing painted, not the common empty-block path. Design:
  [`research/2026-08-09-page-collapsed-caret-pending-marks-cue.md`](../../../../research/2026-08-09-page-collapsed-caret-pending-marks-cue.md).
- **The inline-code chip cannot carry it instead** — settled, so it is not
  re-asked. Both caret states are the SAME DOM position (the code `TextNode`'s
  end), so the browser paints the caret at one x either way; restyling that one
  span needs a class on a node Lexical owns, i.e. a content write, which the
  virtual-delimiter design rejects for the reasons it rejects real seams; and the
  only route left is a fake caret (`caret-color: transparent` plus our own
  blinking bar), rejected because a missed state change leaves the user with no
  visible caret at all, and it fights IME, forced-colors mode and caret blink.
- **The second component is not restorable.** It lives outside the document, so
  undo, reload and any remote edit lose it — all degrading to depth 0, the safe
  side. There is no address to restore it *to*; see the citations in
  `internal/mark-depth.ts`.
- **`markArriveFor`'s `offset ± 1` is a linear CHARACTER step, not a caret step**
  — wrong for grapheme clusters (a seam right after an emoji or a combining mark
  places the caret mid-surrogate). Pre-existing, covered by no test.
- **`color` and `link` are not delimiters.** `link` needs nothing — Lexical
  already moves a collapsed caret out of an inline parent whose
  `canInsertTextAfter()` is false. `color` is a genuine gap: stepping out of red
  `` `code` `` leaves the caret red.
- **A mark span across a soft line break is genuinely two spans.** `walkNode`
  emits a line break (and a decorator) as an *unmarked run*, so the strip walk
  stops there and the caret model cannot drift from the persisted one. Document
  it; don't "fix" it.
- **The MARK model is page-editor only** — `primitives/text-editor` mounts
  `PlainTextPlugin`, no marks at all — so it does **not** belong beside
  `decorator-nav` in the text-editor primitive. The crossing CHANNEL is the
  opposite: it is a primitive precisely because a mover must announce without
  knowing who observes.

## Visible-line invariants (Enter / Backspace / Delete)

Split, merge, and the keystroke ladders all restate one fact: the user's mental
model, and the caret's, is the **visible line sequence**, not sibling space
(`parentId`+`rank`).

> Split turns one visible line into two adjacent visible lines: the tail
> becomes the immediately-next visible line; no other line changes position or
> depth. Merge is its exact inverse.

### Split adoption

**Adoption rule** (`applySplit`'s non-`asChild` arm, `core/block-ops.ts`): when
the origin has *visible* children (`block.expanded && childrenOf(...).length > 0`),
the tail adopts all of them — reparented to the new id, ranks preserved
byte-for-byte — and is opened. Collapsed children are not visible lines, so they
stay with the head, which deliberately keeps its own `expanded: true` even with
zero children afterward (harmless — no chevron without children — pinned by test
as a decision, not an oversight).

Adoption is **derived inside the reducer from the current forest state**, never
carried on the op as a flag minted at intent time: ops apply against the CURRENT
forest (the overlay replays onto a refreshed base; the server applies against its
own load), so a frozen flag could contradict the forest by the time the op applies
(e.g. a racing collapse). Spec: `block-ops.test.ts`'s `split ∘ merge round-trip`
(~500 seeds), where equality is **structural** — merge mints fresh ranks on every
adoption, so comparing rank strings would fail even on a correct round-trip.

### Enter at the START of a non-empty block preserves the origin's identity

At offset 0 with text after the caret, split inserts an **empty sibling ABOVE** and
leaves the origin untouched (same id, text, children, content doc, `data`,
`expanded`), caret staying put — so the origin's **block id never changes** and
every block-id-keyed thing (content-doc registry, its owner and run tracker, undo
focus routing) stays stable. Notion's model; pinned by `block-ops.test.ts`'s
`identity:` split cases and `e2e/enter-at-start-verify.ts`.

The discriminator is `op.position === 0 && afterRuns.length > 0` (vs **empty-block
Enter**, which still spawns an empty sibling BELOW and moves the caret down). Both
the pure reducer (`applySplit`) and the web executor (`makeBlockAPI().split`) branch
on the *same* condition; the executor branch is load-bearing, not cosmetic — it
skips the origin's live-doc `truncateAt(0)`, which would wipe the whole content doc.
See
[`research/2026-07-22-page-enter-at-start-identity-preservation.md`](../../../../research/2026-07-22-page-enter-at-start-identity-preservation.md).

### The keystroke ladders

`web/internal/keystroke-intent.ts` applies the same visible-line idea to
deletion and to escaping structure:

> **Backspace** deletes the nearest visible thing to the LEFT of the caret:
> marker glyph (convertTo) → **excess** indentation (outdent) → line break
> (merge) → any remaining indentation (outdent) → boundary (nav-left).
>
> **Delete** deletes the nearest visible thing to the RIGHT of the caret:
> the line break below (merge the next visible line up) → boundary (nav-right).
>
> **Empty-Enter** escapes one structural level per press: indentation first
> (outdent, keeping the type), then the type (convertTo), then ordinary split.
> Inside a container the box is not indentation: it is left only from its last
> line (see *Empty-Enter leaves a container only where its flow ends*).
>
> **Enter over a selection REPLACES it** — a native range inside the line (a
> double / triple click, Shift+Arrow) as a text span across lines: the text goes
> and the line splits where it started, as ONE undo entry. The split is resolved
> against the line as the deletion leaves it (the caret at the range's start, at
> the line's start / end when the range began / ended there), and the
> empty-Enter ladder never runs — a selection is text being replaced, not an
> empty line to escape. The range rides the split op (`KeyIntent.deleteTo`): the
> op's `runs` are the line with the range cut, so the tail seeds from the text
> AFTER it; the origin's doc loses the range by the split's own truncation, or —
> for a range from the line's start, where the split keeps the origin and mints
> the empty line above — by an explicit `deleteRange` recorded on the same entry.
> It used to split at the selection's ANCHOR and delete nothing.

Backspace's and empty-Enter's ladders order `convertTo`/`outdent`
**oppositely, deliberately**: Backspace strips what's visually nearest the caret
(the marker sits right there), while empty-Enter escapes nesting outward (the
type is the outer layer). Every rung is pinned by `keystroke-intent.test.ts`
(`Backspace` / `Delete` / `Enter` describes); its `trajectories` describe is the
multi-step spec, re-resolving a fixture across repeated keystrokes.

**Only EXCESS indentation is nearer than the line break above** (Notion's model,
`hasExcessIndentation`) — indentation the block SHARES with the visible line below
it isn't standing between the caret and that break, so peeling it would misalign
the block from its surroundings and leave the break still there. Hence the two
middle rungs **swap order** on that predicate instead of being fixed: a block
level with the line below merges in one press; a block deeper than it peels only
the excess levels first. Nothing below at all = excess against the top level, i.e.
the original ladder, unchanged.

Stated on depth, computed structurally (`!hasExpandedChildren && !hasNextSibling`)
— identical predicates, since `nextVisibleLine` yields a child (deeper), else a
next sibling (same depth), else an ancestor's follower (shallower) or nothing.

- **This rung's outdent can never adopt followers**: excess implies no next
  sibling, so `outdentOne` re-parents nothing — never the silent re-nesting
  `unwrap` exists to avoid, which the first child of an *ordinary* (non-anchor)
  parent used to hit here.
- **Outdent stays as the FALLBACK rung below merge**, for when there is no break
  above after all (page boundary, or a text-less previous line). Without it,
  deferring outdent removes the only escape from nesting for such a block.

**A ladder is only as good as the caret context feeding it.** Every rung gates on
`caret.atStart` / `caret.atEnd`, so `readCaretContext` returns **null** for an
anchor it cannot resolve (keystroke passes through) rather than `offset: 0`
alongside `atStart: false`, which silently demotes *every* structural keystroke to
a passthrough. In particular a **root**-anchored selection is a legal
document-level position that `$linearCaretOffset` must resolve as one — Lexical
produces it whenever the selection first materializes while the root is childless
(the normal state of a freshly split block), and never re-anchors it.

**Delete's ladder is deliberately one rung, and that is not an omission.**
Backspace's ladder is long only because the *current* block's own marker and
indentation sit physically between the caret and the line break above it. To the
right of a caret at end-of-line nothing does — the next block's marker and indent
are *after* that break, so they are not nearer. "Completing" Delete's ladder would
make it take three presses to remove one line break, which no editor does.

**Delete needs no new reducer op — it is Backspace's merge from the opposite
originating block.** That identity holds only because
`prevVisibleLine(nextVisibleLine(X)) === X` for every X with a next line (the
`duality` property test over the fuzz forest is the executable spec), which is why
`prevVisibleLine` has an **upward branch**: a first child's previous visible line
is its parent, so it can return a parent, not only a leaf. `mergeNext` resolves its
source to `nextVisibleLine(this)` and merges up the SAME `mergeBlock` path
Backspace uses, so the caret sits at the join and does not move. The source is a
*different* block, so its live runs come from `BlockFocusHandle.readRuns`; the
~1s-lagged `runsOfNode` fallback is reserved for **text-less** blocks that register
no handle, where empty runs are the true answer rather than an absorbed miss.

### Merge's adoption slot follows the same visible-line rule

Adopted children occupy the visible position the merged block occupied: when the
target is the merged block's own PARENT (the upward `prevVisibleLine` case — the
block is therefore the first child) they land BEFORE the block's former next
siblings (`Rank.nBetween(null, nextSibling(source)?.rank ?? null, n)`); otherwise
(target is a prev sibling's deepest leaf, nothing of the target's follows) they
append after the target's existing children. Both `PAGE_BLOCK_TYPE` refusals hold,
including "the parent is the page row".

### The `dataOnSplit` seam

(Checked to-do → unchecked tail, generalized.) Declared on the block handle in
**method syntax** — the same bivariance trap `text` documents in `define-block.ts`
(a property-typed function is contravariant in `data` and breaks
`BlockHandle<unknown>` registry assignability). Resolved in the **resolver**, not
the reducer or executor, because only the resolver sees block handles; guarded to
`tailType === node.type` so a heading→text end-split never runs the heading's
transform against the text schema. The result rides as `op.tailData` because the
pure reducer cannot see handles at all; absent means inherit. Bad payloads are
still caught by the strict `parseBlockData` at the write boundary.

### An op's target set is what it WRITES, not only what it names

An overlay op declares a set of block rows. `sameOverlayTarget` intersects two
such sets, and the overlay's ordering rule makes an op wait while an older
still-pending op on an intersecting row survives the pass. That set is the
**union of what the reducer measurably wrote and what the op names**:

```
targets = writtenIds(before, after) ∪ opNamedIds(op)
```

`predictOp` (`web/internal/optimistic-block-ops.ts`) builds it once per dispatch,
running the reducer once and measuring its own before/after pair. So a split's
adopted children, a merge's unnamed target row, a delete's cascade and an
unwrap's promotion are all in the set — the reducer's output reports them, and
the op never had to mention them.

**Why the union rather than the measured diff alone.** The diff is *smaller*
than the named set in real cases. An end-of-line split rewrites the origin's
`data.text` byte-identically, so the origin does not appear in the diff. An
Enter-at-start split leaves the origin untouched entirely. A partially-refused
indent moves fewer rows than it names, and a `bulkMove` names its whole
selection while only the roots move. Taking the diff alone would drop the origin
row from a split's set and re-open the very hole the measurement closes: a later
patch on that row would stop being blocked. The union is monotone — coverage
never decreases against naming alone.

**The residual bound.** The set is frozen at DISPATCH, against the base the op
was predicted on. At replay the base can differ, so the set the op really writes
may be a strict superset: adoption that appeared because a racing expand landed,
`prevVisibleLine` resolving to a different target, a cascade that grew. That is
inherent — `sameTarget(a, b)` sees only the two ops, never a base, and blocking
has to be decided before the replay that would measure it. It stays safe here
because the relation is a symmetric intersection, and an over-match only DEFERS
a departure. The guarantee would **invert** under a subset test (a missing id on
the *older* side makes it pass), which is why the primitive blocks rather than
absorbs. `overlayOpTargets`' doc comment is the canonical statement of all of
this.

This does not weaken the adoption rule above. `targets` is a prediction recorded
*alongside* the op, never a flag the reducer reads — adoption is still derived
inside the reducer from the forest the op is applied against.

## The selection highlight belongs to the RUN, not to the row

> A row paints **no** selection highlight of its own. The highlight is a sibling
> decoration spanning the grid lines of a maximal run of selected visible lines
> — the same shape as a container frame, resolved the same way.

Don't "simplify" it back to a class per row. N selected blocks are ONE region and
the user reads them as one; N boxes restate them as N, and every internal
boundary then draws two rounded corners and two hairlines meeting — a
three-paragraph selection renders as three stacked cards. Those seams are
structural, so they are removed structurally: a run is one element and has no
internal edges to draw.

`internal/selection-bands.ts` resolves the runs, `components/selection-bands.tsx`
paints them, `block-editor.tsx` calls it (like `RailSeat`: "is the line above me
selected too" is unknowable from a row alone). Rounding is a property of the run,
not the row. A run splits into TOUCHING bands wherever the decoration edge steps
(a selected block deeper than the line above it) — a notch in one region, not two
boxes. A selected container paints over its frame span, so `handle.anchor`'s
zero-height row needs no branch. The band spans `C` → the row's right edge, one
`BLOCK_INSET` OUTSIDE the box `ContainerBackdrop` fills: a highlight wants
padding around the thing it highlights, so a selected callout's band surrounds
its tint rather than tracing it.

## The block list is a document, not a listbox

> The block list's container is a **named group of editable blocks**
> (`role="group" aria-label="Page blocks"`). No composite ARIA role is honest
> here, so it claims none.

Every row holds a `contenteditable` editing host. A composite role is a contract
about its children — a `listbox` promises options, a `tree` promises treeitems —
and there is no child role a rich-text editing host can wear. The container used
to say `role="listbox" aria-multiselectable`, which was **worse for a screen
reader than no role at all**: it announced an empty list (nothing below it was an
option), and it flattened the subtree, hiding the headings, lists and quotes that
are the entire point of a page.

- **Do not add `role="option"` to a row.** It is the first fix everyone reaches
  for, and it is the trap: an option's accessible name is its text content, so
  stamping it on a row collapses the editing host into a label and takes the
  editing semantics with it. The lint rule
  `aria-safety/no-orphan-composite-role` fails a re-added `listbox` here; nothing
  mechanical stops the `option` half, so this paragraph is the guard.
- **`aria-selected` is unreachable, not merely unused.** It is supported only on
  `option`, `row`, `gridcell`, `tab`, `treeitem`, `columnheader` and
  `rowheader` — and none of those may host a `contenteditable`. So the state has
  no attribute to live in.
- **Switching roles for the duration of selection is not available either.** It
  would mean `contentEditable={false}` on the rows while selecting, which
  deadlocks the caret authority's landing (see *The caret authority*): the
  authority parks the keyboard on the container and waits for an editing host
  that a role swap has just removed.

Two channels replace the missing attribute, and neither is decoration:

- **The selection is spoken on every range change.** The range moves in exactly
  three places — `applyRange`, `selectEveryBlock` (Cmd+A), and `clearSelection`, all in
  `internal/use-block-selection.ts` — and each announces through
  `primitives/announce`. `"Heading 2: Container frames, block 3 of 12, selected"`,
  `"…, 4 blocks selected"`, `"All 12 blocks selected"`, `"Selection cleared"`.
  A block is named by the host's `describeBlock` (type label + a short text
  preview), so the hook stays domain-free. Two guards keep it honest: an
  unchanged range is silent (a marquee drag re-applies the same range every
  pointermove), and a clear over an empty selection is silent.
- **A selected row says so, in words.** `BlockRow` renders
  `<span className="sr-only">{isSelected ? "Selected. " : ""}</span>` as its
  constant first child, in both branches. Always mounted, empty when unselected —
  the row's children list must keep a constant length, and `sr-only` is
  `position: absolute`, so it perturbs no rect drag/drop/marquee measures. The
  flag arrives as a prop from the editor (which already recomputes every row on a
  selection change), never as a per-row subscription to the selection store.

**Headings are exposed now** — which is what dropping the listbox was for: a
block type declares `role="heading"` + `aria-level` and the shared skeleton
stamps them on its line (*A block type declares its ARIA identity*). That lives
in the block-type presentation API, not on this surface.

**Known bounds:** a run of list blocks is still no `list` of `listitem`s, and a
`quote` / `callout` container is no `blockquote`. Same section states why, and
why the answer is `aria-owns` rather than another role.

## A selected block always carries its children

> The selection is **closed under descendants**: a range that names a block names
> every block nested under it. `rangeWithDescendants`
> (`internal/selection-closure.ts`), applied in `applyRange`.

Every structural op acts on the selection's subtree ROOTS — `bulkDelete`,
`bulkDuplicate`, the clipboard's `serializeForest`, `indentBlocks`, the bulk drag
— and a root carries its subtree. So a selection that showed a parent WITHOUT its
children was showing the user something other than what the next keystroke would
do: selecting a parent and its first child and pressing Backspace deleted the
second child too, which was never highlighted.

The closure goes in `applyRange` because that is the ONE funnel every range change
passes through — Escape inside a block, a click, Shift+Arrow, the marquee drag,
the pointer landings in `block-editor.tsx`. Closing it there is what makes the
open range unspellable downstream: the reducer stores the closed range, so the
highlight bands, each row's `isSelected`, the spoken count and the ops all read
the same thing and none of them re-derives it. Don't add a second closure at a
consumer — if one is ever needed, the funnel moved.

Three consequences worth knowing before touching the range machinery:

- **The result is still one contiguous `[anchor, head]` range.** In a depth-first
  flatten a block's descendants are the rows directly after it while the depth
  stays greater, so the closure only ever pushes the range's BOTTOM end further
  down. It never splits the range and never reaches above it — selecting a child
  does not select its parent, because acting on the child leaves the parent where
  it is.
- **An upward range grows at its ANCHOR**, that being its bottom end. This is the
  one place the anchor moves under the user, and it is honest: the anchor is an
  end of the selection, and the selection now ends lower.
- **Shrinking a range below a subtree is not available.** Shift+ArrowUp off a
  selected parent re-closes to the same selection, so nothing moves. Correct, not
  stuck: the parent is selected, so its children are.

Depth, not `parentId`, is what the closure reads, and it comes from the visible
flatten (`visible`, mapped off `flat`): what a selection may cover is what the
user can SEE. A collapsed container's hidden children are not rows at all — they
still travel with their root, because the op acts on the subtree — and its
borrowed line is one.

The arrow keys follow from the closure: **Shift+Arrow moves the head (extending),
a plain Arrow leaves from the range's EDGE** — its last block going down, its
first going up (`edge()`). Stepping from the head instead would walk a plain
ArrowDown back into a range drawn upward, and back into a parent's children.

## Block-selection mode: the container handles only keys it originated

Block selection lives on `internal/use-block-selection.ts` (range state + the
container's focus/keyboard policy), driven by the `SelectionControl` deep children.
It takes its structural surface as an `actions` prop rather than reading
`useBlockEditor()`, so it depends on nothing but React and the multi-select reducer
— which is what makes it jsdom-mountable (`web/__tests__/block-selection.test.tsx`).

The load-bearing invariant:

> The selection container's `onKeyDown` acts **only** on keystrokes whose
> `e.target` is the container itself. Never `document.activeElement`.

The container is an ancestor of every block's `contenteditable` and React delegates
`onKeyDown` from the root, so a key a block already consumed still bubbles here.
`document.activeElement === containerRef.current` is a TOCTOU: `enterSelectionMode`
*moves focus to the container* mid-dispatch, and the synchronous discrete `focusin`
makes React flush + re-render before the still-bubbling keydown arrives — which then
claims the event and undoes what the block just did. `e.target` is fixed at dispatch
time and no handler can move it. Pinned by `block-selection.test.tsx` ("keys targeted
at a block editor never reach the container handler") plus
`e2e/block-selection-verify.ts` for the single-dispatch symptom jsdom cannot
reproduce. See
[`research/2026-07-10-page-escape-block-selection.md`](../../../../research/2026-07-10-page-escape-block-selection.md).

The **clipboard** handlers in `block-editor.tsx` deliberately keep the
`activeElement` check — "does the container own the clipboard right now?" is a
genuine `activeElement` question, and a `copy` event's target follows the DOM
selection, not focus. They FIRST decline any event already `defaultPrevented`:
a caret paste that a block's editor spliced can CLAIM the caret for the line it
created, which focuses the container mid-dispatch — so `activeElement` alone
read "the container owns it" and the same forest was pasted a second time, as
whole blocks (found by `e2e/cross-block-span-verify.ts` phase 11).

The second invariant, and why `focusContainer()` is not just a `.focus()`:

> Entering block-selection mode **relinquishes the text caret**. The mode owns the
> keyboard; no caret may stay parked in the block the user just left.

Focusing the container does not move the DOM selection, and Lexical re-derives every
commit's pending selection *from the DOM selection*. A caret left in a blurred block
lets any **untagged** reconcile conclude "the caret didn't move, so my root should have
focus" and call `rootElement.focus()`, destroying the selection with no user input.
Tagging is not an option: `@lexical/yjs` issues an untagged follow-up commit
(`$ensureEditorNotEmpty`) outside its own `COLLABORATION_TAG` block and exposes no
update-options seam. So `releaseCaret` drops the DOM selection instead — with no
caret a reconcile has nothing to restore, robust to ANY async refocus rather than one
trigger. See
[`research/2026-07-17-page-block-selection-focus-steal.md`](../../../../research/2026-07-17-page-block-selection-focus-steal.md).

Consequence before touching the selection bar: with no caret, a `copy` provoked from a
bar BUTTON has neither a selection for `execCommand("copy")` to fire on, nor a path to
the container's `onCopy` (the bar renders *outside* the container, so the event targets
the button). `copySelectionViaButton` handles both explicitly. Cmd+C / Cmd+X are
unaffected — they originate inside the container.

The third invariant is what the first two cost every control rendered *inside* the
container:

> **The rail never takes the keyboard.** A gutter control ACTS ON a block, so it
> must not become the focus target that ends block-selection mode.

Neither rule above yields: focus-scoping is what keeps the highlighted selection and
the live keyboard in agreement, since `onKeyDown` answers only to
`e.target === container` — a selection surviving a focus move onto a button would be
highlighted but keyboard-inert. So every control in `block-rail.tsx` goes through
`RailButton`, which suppresses the press's default (the same mousedown +
`preventDefault` idiom `block-row.tsx` uses for Shift+click). Without it, mousedown on
the drag handle cleared the selection before dnd-kit's 4px activation distance was
travelled, and every multi-block drag silently degraded to a single-block `move`.
Nothing downstream wants that default: `PointerSensor` activates off `pointerdown`,
the block-actions popover opens on `click` and refocuses by an explicit `.focus()`,
and Tab still reaches the handle.

Consequence one level up: **dragging a block that is not in the live selection clears
that selection explicitly** (`onDragStart`'s non-bulk arm — Notion's model). It used
to be a side effect of the focus steal, so it now has to be said, or a single-block
drag leaves a stale highlight over blocks the gesture never touched.

### A text drag becomes an editor-owned span at the first boundary

`onPointerDown`'s two entry points (background marquee, text) feed one tracking loop:

> A drag starting inside a block's text belongs to the BROWSER until the pointer
> leaves the origin row; then the editor takes over with an editor-owned TEXT
> span — partial at both ends — that it holds, paints and edits itself.

The browser cannot do it: each block is its own contenteditable **editing host**,
and a selection is clamped to the host it started in — dragging out *collapses* it
(pre-change baseline recorded in `e2e/cross-block-text-selection-verify.ts`:
`{collapsed: true, text: ""}`, Cmd+C copied `""`). So the span is the editor's,
not the browser's. Design: [`research/2026-10-09-page-cross-block-text-selection.md`](../../../../research/2026-10-09-page-cross-block-text-selection.md).

**The selection is a union** (`internal/use-block-selection.ts`): nothing, a block
range (the multi-select state), or a text span — never two at once, because each
setter (`applyRange`, `setTextSpan`) retires the other. A span behaves like block
selection toward the keyboard: the container holds focus and `releaseCaret` drops
any DOM selection (the span is PAINTED, see below). So the container answers every
key a selection answers (`onSpanKeyDown`):

- **Escape climbs the ladder** — a span becomes the block range of every block it
  touches. That is how the whole-block ladder stays reachable from text: Escape
  (in a block, or on a span) → blocks, then Shift+Arrow extends BLOCKS, exactly as
  before. Shift+Arrow from text itself now draws a span (below).
- **Delete / Backspace** delete it (`deleteSpan`, below) and land the caret at the
  join; a plain arrow collapses it to the end it points at.
- **Typing over it.** A printable key REPLACES the span: one typed character is
  part of the span's own edit (`joinAroundSpan(…, typed)`: head + character +
  tail, the character wearing the marks typing there would), so it is one op and
  ONE undo step — as typing over a selection inside one block is one typing run.
  Shift+Enter is the same: its soft line break is a character of the line.
  **Enter is one entry too** (`breakSpan`): the `deleteSpan` op then the
  `split` op the join would make, both predicted before either is dispatched
  (`replaceSpan`'s shape), the split resolved by the keyboard's own resolver
  against the rows the delete leaves (`enterReplacingIntent` over
  `intentContextOf` — the one context builder the keyboard uses too), so the
  tail's type, data and nesting are a typed Enter's. It used to be replayed at
  the join through the flight buffer, which recorded the split as a SECOND
  entry: one Cmd+Z put the line break back and left the span deleted. Other
  keys still ride the buffer (`landWithInput`). A composition key (an IME's `Process`, a dead key)
  carries no character: the span is deleted and the caret landed, and the
  composition starts with the NEXT key — the flight's own documented bound (*The
  caret authority*), for the same reason (the container is no editing host).
  Keys typed after the landing are an ordinary typing run, i.e. one more undo step.
- **Shift+Arrow moves the head**: ±1 caret position left/right (a token or a
  surrogate pair is one position, `stepTextOffset`; crossing into the neighbouring
  line at an edge), one visual line up/down at a remembered column (`goalX`,
  crossing into the neighbour's edge line). A head stepping back onto the anchor
  is a caret again; a head reaching a line that cannot end a span widens the
  selection to blocks (`normalizeSpan`), from where the keyboard extends blocks.

**Shift+Arrow off a block's edge draws a span** (`extendSpan`,
`internal/keystroke-intent.ts`). Shift+Up/Down with the selection's FOCUS on the
first/last visual line, or Shift+Left/Right with it at the very start/end, and a
visible line beyond: the native selection cannot leave its editing host, so the
executor hands the gesture to `SelectionControl.extendSpan` — anchored at the
native selection's ANCHOR offset (`caret.offset`), its head in the neighbouring
line (`SpanMotion.enter`: the line's end / start, or the point at the focus's
column on its last / first visual line). With no line that way the key stays the
browser's (it extends to the block's own edge). This replaced `selectBlock`, which
jumped straight to whole blocks; whole blocks are one Escape away (above). The
caret context carries the focus separately (`CaretContext.focus`) because a range
grown to the edge by Shift+Arrow has its focus there while its anchor — what
`offset`/`onTopLine` describe — is still mid-line.

`internal/span-motion.ts` is the keyboard's geometry: pure DOM reads over the
rendered lines' text surfaces (`domRangeOf` rects for the visual lines and the
head's point, `offsetAtPoint` for the column hit), handed to `use-block-selection`
as one `SpanMotion` capability so the hook stays DOM- and registry-free (and
jsdom-mountable). A container anchor with visible children paints no line, so a
step passes over it.

**`normalizeSpan` (`core/text-span.ts`) is the ONE constructor of a span**, so its
properties hold for every span the editor ever holds: ends ordered in visible order;
both ends text-bearing, mergeable lines (not a page row, a container anchor, a void
block, or a line with no mounted text surface) of ONE page — anything else widens the
whole gesture to the touched blocks; offsets clamped into the line and snapped OUTWARD
off any inline token (`blockTextProtectedSpans()`), so a cut never splits a chip.
Consumers therefore never re-check an end.

- **Never intercept the text press on the way down** — no `preventDefault`, no
  `focusContainer()`. Until the pointer leaves the row, native intra-block selection
  IS the feature.
- **The anchor is read at promotion, BEFORE `focusContainer()`** — off the origin's
  native selection anchor (`nativeAnchorOffset`), which `releaseCaret` is about to
  drop (falling back to the press point). Read after, it is gone.
- **The head is re-read on every move** under the pointer (`offsetAtPoint`, which
  moves no caret; a pointer beside the text is clamped into the text's own box, and
  above / below it resolves to the line's start / end), then re-normalized. So the
  selection follows the pointer between the union's arms: a partial span while both
  ends are text, the touched blocks whole while the pointer sits on a line that
  cannot end one.
- **There is no one-way rule any more.** It existed because dragging back into the
  origin could only be honoured by re-seating a partial caret in a blurred block —
  the state `releaseCaret` exists to prevent. A span inside ONE block is legal, so
  the gesture returning to its origin is just a span there: nothing is re-seated.
- **`select-none` for the rest of the gesture, COMMITTED SYNCHRONOUSLY at promotion**
  (`flushSync`), not one `releaseCaret`: the pointer is still down, so the browser's
  drag-selection re-seats a range in the origin host as the default action of every
  pointermove the class has not yet reached. Through ordinary state it landed a frame
  late, which showed a native selection BESIDE the painted span. The per-move
  `focusContainer()` is now only a backstop.
- **One selection at a time** — a span (or a block range) and a native selection are
  never visible together: focusing into a block (a click, a double / triple click)
  clears the span through `onFocusCapture` before the browser's selection paints.
  `e2e/span-native-selection-verify.ts` A samples `getSelection()` on every pointer
  step of the drags (down, back into the origin, from a line's edge, upward, held at
  an auto-scrolling edge, pointerup) and after double / triple clicks.
- **Copy / cut / paste.** See *A span on the clipboard* below.

**Holding at either viewport edge scrolls the document and keeps the range growing**
(`useEdgeAutoScroll`, from the scroll-owning `auto-scroll` primitive). Three rules:

- **One applier, two clocks.** `applySelectionAt(clientY)` is the entire per-move
  body, called from `pointermove` **and** from the hook's `onScroll`: with the pointer
  parked at the edge the pointer did not move, the CONTENT did, so re-evaluating only
  on `pointermove` would scroll the document and select nothing new. Mirror rule:
  **`track` is fed from the pointer handler only, never from the applier**, or the
  hook re-latches off its own callback.
- **It engages only once the gesture is already OURS** (`dragMovedRef` /
  `textDragPromotedRef`), never at pointerdown. The trailing `min-h-40` empty zone
  sits exactly inside the bottom edge band on a full page, so engaging on the press
  turns a plain click there into a runaway scroll under a stationary pointer — which
  arms `dragMovedRef` and swallows `onEmptyClick`, i.e. click-to-edit at the bottom of
  a page stops working. Pre-promotion `text` is the same rule: the browser still owns
  the gesture.
- **`dragStartRef` carries two coordinate spaces; do not collapse them.** `x`/`y` are
  VIEWPORT (`onEmptyClick` compares the press against live row rects). `contentY` is
  the press inside `contentRef`'s box, because the marquee is an absolutely-positioned
  CHILD of that box: subtracting a frozen viewport `y` from a content rect re-read
  every frame drifts the anchor by exactly the pixels scrolled since the press, and
  drops them from `height` entirely. The `> 3` drag threshold measures `contentY` too,
  so a stationary pointer over a scrolling surface counts as the drag it is.

`pointerup` and `pointercancel` share one teardown; cancel skips the click branch (a
cancelled press is not a click). Missing the cancel listener used to leak two inert
listeners — now it would leak a scroller with no pointer left to end it.

Already correct, load-bearing only now: the per-move `focusContainer()` survives 60fps
ONLY because it focuses with `preventScroll: true` (`internal/use-block-selection.ts`),
else focus fights the scroll every frame; and `rowAtPointer`'s nearest-row fallback is
what keeps the range extending while the pointer sits below the last block.

### A native selection lives in an editing surface, or nowhere

> Inside the editable block list, a native text selection may exist ONLY inside a
> block's own editing surface — its Lexical host, or the native control a block
> brings of its own (the code block's `<textarea>`). The surface is
> `user-select: none` and re-enables exactly those
> (`components/block-selection-scope.css`).

Every block is a separate editing host, so a selection ANCHORED anywhere else is
one this editor cannot represent. Nothing clamps it — clamping is per editing
host and its anchor is in none — so it runs across the whole document; it paints
over the block selection the same gesture is building; and copying it yields the
rows' `sr-only` "Selected." markers rather than their text.

The bug it closes is the reported one: a drag starting in the left area
highlighted the page from far above the gesture, *sometimes* — the hit-test
answer depends on which box's padding the press lands in, so the same gesture
leaked on one row and not the next.

- **It is a property of the SURFACE, not a decision per gesture.** Cancelling
  the press in `onPointerDown` was the obvious fix and is the wrong rung: it has
  to be re-decided in every branch that classifies a press, and the branch that
  starts NO gesture — a press on block content the editor deliberately leaves
  alone — is the one that leaked the whole-document selection. A press cannot
  start what nothing on the surface allows to start.
- **The exemption drops for one gesture**, the text drag promoted to an
  editor-owned span (`.block-list-editing-selectable` comes off): the pointer is
  still down, so the browser re-seats a range in the origin host every frame.
  That is the same suppression the old one-off `select-none` performed, restated
  as the absence of an exemption.
- **A text span is why this holds for cross-block text too.** A selection
  spanning blocks is exactly what no editing host can represent, so the editor
  never asks the browser for one: the span is offsets the editor owns, painted
  with the Custom Highlight API (next section) — the DOM selection stays empty.
- **`read-only-view` is deliberately untouched.** It mounts no editing host, so a
  selection spanning its blocks is ordinary document text the user may copy.

### The text span is painted, never native

> A span is OFFSETS (`SpanPoint`: block id + linear offset in the stored-runs
> basis). DOM `Range`s are derived from them for painting, per paint, and are
> never the span's state.

`components/text-span-highlight.tsx` paints it through the CSS Custom Highlight API
(`CSS.highlights`, name `page-text-span`, styled in `block-selection-scope.css`).

> **Selected text is ONE colour, native or painted**: the theme's
> `--text-selection` (color-palette's `textSelection`), worn by both the
> browser's `::selection` inside the editing hosts and `::highlight(page-text-span)`.
> A user must not be able to see where the native selection inside the origin
> block stops and the painted span starts — which is also why it is a theme
> token and never a local tint (it used to be the bands' `primary/15`, nearly
> invisible on a dark background). `e2e/span-native-selection-verify.ts` B
> compares the two fills pixel-for-pixel in both schemes (with shadows off: the
> native selection's format toolbar floats right above the line, and its
> popover shadow darkens the word in dark mode). It paints Ranges across editing hosts with no DOM mutation (which
would fight Lexical/Yjs reconciliation) and no native selection (which no host can
hold). One Range per covered TEXT line — `[from, len)` on the start line, whole
lines between, `[0, to)` on the end line — through the handle's `domRangeOf`, which
resolves offsets with the caret's own `$resolveLinearOffset`, so a painted end and a
caret landed at that offset are one DOM position.

- **Clamp on re-resolve.** Each covered line's editor update (`onTextUpdate` — local
  or a remote collab edit) re-derives the Ranges, and `domRangeOf` clamps into the
  text the line holds THEN, so a shortened line never leaves a Range past its end.
  A span END whose line leaves the document clears the selection; a middle line
  leaving is harmless (the op derives the lines between afresh).
- **Text-less middle lines keep the row band** (an image, a divider): there is no
  text to highlight, so `resolveSelectionBands` receives just those ids. A container
  the span only ENTERS (an ancestor of its end line) is painted neither way —
  `deleteSpan` keeps that box.
- **One registry, many painters.** `CSS.highlights` is per document and two page
  panes are two editors; each painter owns an entry and the registered `Highlight` is
  their union.

### Deleting a span is ONE op (`deleteSpan`)

`{ kind: "deleteSpan", targetId: A, sourceId: C, runs }` — one undo entry, one server
transaction (three ops would let another client observe, and a failure leave, a
half-applied edit). `runs` is A's whole result, head + tail (`joinAroundSpan`), not
C's tail alone: only the client knows where in A the span starts. The lines between
are NOT a parameter — `applyDeleteSpan` derives them as the visible lines strictly
between A and C:

1. each is trashed with its subtree, EXCEPT C's ancestors: a plain ancestor is
   unwrapped (its line goes, its uncovered children — C's branch and what follows —
   are lifted into its slot), a container anchor ancestor is KEPT (the span covered
   its first lines, not the box; the empty-anchor prune drops it if C was its last);
2. C merges into A by merge's rule (`mergeInto`, shared with `applyMerge`) — or, when
   C still sits in a kept box, C's children take C's slot inside that box;
3. merge's refusals on both ends (page row, anchor, text-less type, C not below A).

The executor (`commitSpanEdit` in `block-editor-context.tsx`, behind `deleteSpan`
and `replaceSpan`) is `mergeBlock`'s shape: predict + zoom check first, then A's doc
spliced to its result runs inside its owner's `untracked` scope
(`spliceOpenBlockDoc`), THEN the op dispatched, recorded as ONE entry carrying A's
runs edit. A span inside one block is no op at all — that runs edit alone, done
synchronously (not `recordDocEdit`'s deferred one: the container's handlers run
outside any Lexical update, and the caret's landing must queue BEHIND the edit).
Either way the caret lands at the join, one microtask later, behind the binding's
relay of the splice.

### A span on the clipboard

- **Copy writes a PARTIAL forest as `"text"`** (`spanForest` in
  `block-editor.tsx` → `writeForestToClipboard(…, "text")`): the covered lines,
  roots resolved as a block selection of them (`blockSelectionRoots`, so nesting
  survives), the start line from the span's start and the end line up to its end
  (`serializeForest`'s `runsOverride`), every covered line's text read LIVE
  (`readRuns` — `data.text` trails the doc by ~1s), and a visible line under a
  covered root that the span does not cover left out (`exclude`; a covered line's
  collapsed children still travel, as in any copy). A container the span only
  ENTERS is not a root of its own. Because the payload says `"text"`, its paste
  SPLICES into the caret's line (the start line's tail merges into it, Notion's
  model) instead of landing as whole blocks. The `text/plain` markdown fallback is
  the same forest. A span inside ONE block copies just the substring, as one plain
  paragraph (the registry's `defaultText` type) — inline wherever it is pasted.
- **Cut = copy, then `deleteSpan`.**
- **Paste over a span REPLACES it** (`pasteOverSpan` → `replaceSpan`), classified by
  the one transfer door with `inline: true` (single-line text has no Lexical host
  to land natively in, so it is parsed into its paragraph and spliced too). ONE
  undo entry: a paste that creates no line is the span's own edit with the pasted
  text in its result (one `deleteSpan` op — or a text edit inside one block); one
  that creates lines is the `deleteSpan` op then the `splice` op, the splice
  PLANNED against the rows the delete leaves (`planSpliceOn`, shared with
  `splice`), both predicted before either is dispatched, both dispatched under one
  entry id, and recorded as ONE entry bracketing the gesture (before the delete,
  after the splice) with A's runs edit. Two server transactions in issue order on
  the page's one send lane (*B — order*); each is valid alone. On the zoom root the
  splice is a paste BELOW it, so there the span goes as its own step (two entries).
  A pasted FILE deletes the span and lands after its start line (two entries: the
  upload is its own write).

### A row's pure geometry is background

The other half of the same press. `TextBlockLayout`'s skeleton boxes — the
padding box, the box, the line, the marker column — carry `data-block-chrome`,
and `onPointerDown` reads a press on ONE of them (identity, never `closest`) as a
background press, exactly as it already read a void block's `data-caret-host`.

Without it the ~16px strip between a row's decoration edge and its text was a
**dead zone**: the editor returned early (a row descendant that is neither text
nor background), so no marquee could start there and a click in it did nothing —
which is also what left that press to the browser, and therefore where the
whole-document selection came from. A `/quote` or `/callout` box's own padding is
the same case.

The glyph inside the marker column is NOT chrome: a press on a bullet or a
checkbox is still that content's own.

Spec: `e2e/gutter-drag-selection-verify.ts`, which drags from four background
x-positions in both directions and asserts no native selection survives. Its
header carries the measured pre-fix baseline.

### Selecting every line a container owns IS selecting the container

> A container anchor renders no line of its own, so a selection covering every
> line it owns is a selection of the container.

Not a convenience — the only way a pointer can say *"this card"*. An anchor's row
is zero height while its children are visible, it carries no rail and no
Shift+click target, and `rowAtPointer`'s height guard skips it outright. So a
drag, a Shift+click and a click-and-extend all reach every line *inside* a
callout or a `/todo` and never the box around them. Left unresolved, "select the
card, copy, paste" pasted the contents with the frame stripped off, and the same
hole let a drag carry the children out of a frame the user thought they were
moving. (`⌘A` was the one gesture that worked, because it selects `orderedIds`
whole — anchors included.)

`withContainersSelected` (`core/block-ops.ts`) closes the selection over it, and
**`blockSelectionRoots` is THE roots resolver for this surface** — copy, cut,
duplicate, drag, move, indent/outdent and the paste anchor all resolve through
it, so a covered container travels as the container in *all* of them rather than
in whichever ones remembered. `isAnchor` is a REQUIRED parameter: there is no
anchor-blind spelling of "the selection's roots" here, which is exactly what the
defect was. The generic `primitives/tree.selectionRoots` has no other consumer in
the repo and is now reached only through this wrapper.

- **Coverage is measured against `visibleChildRule`** — the lines on screen, not
  the stored children. A COLLAPSED container is therefore promoted by its one
  borrowed line, which is what the fold means: that line is everything it shows.
- **Post-order, so nesting resolves in one pass.** A card whose only content is
  another card promotes the inner one first, which is then what covers the outer.
- **A childless anchor is never promoted.** It has a real one-line box of its own
  (the surface's childless fallback) and is selected by pointing at it.
- **Monotone — it only ever ADDS.** An anchor the range already carries (a range
  crossing it from outside, `⌘A`) stays selected whether or not its children are;
  the roots then subsume them, which is ordinary subtree semantics.
- **The highlight reads the same closed set** (`resolveSelectionBands`, and each
  row's `isSelected`), so a covered card paints over its whole frame span — the
  band and the clipboard cannot disagree about what is selected. The multi-select
  range itself stays exactly what the pointer drew: the closure is derived per
  render, never stored, so extending a range is still index arithmetic over
  `orderedIds`.

**Twin of *A selected block always carries its children*, and they close in
opposite directions.** That one closes the RANGE downward — a selected parent
pulls its descendants in, because an op on it acts on them. This one closes the
selected SET upward — covered lines pull their container in, because the box is
the thing they add up to. They compose without knowing about each other: the
range closure runs first and only ever moves the range's bottom end, so what
reaches here is still a plain set of ids to test coverage against.

`⌘C` on a bare CARET is deliberately outside both rules — it copies the line you
are standing in, container or not. See *With nothing selected, the caret's block
IS the selection*.

## The gutter `+` and `/` are one unified menu

Both open the **same** caret-anchored block menu (`components/block-menu-plugin.tsx`,
mounted once per text block) — Notion's model. One `CaretTriggerMenu` surface, one
keyboard model, one filtered `BlockTypeList`; only the *producer* of the open-state
differs, and both are `CaretQuery` handles from the caret-trigger primitive:

- **`/` trigger** (`useCaretQuery`): typing `/` at a word boundary opens it; the
  text after the `/` filters it. On commit the `/query` is stripped in place and
  the block converts, keeping the text around the slash.
- **Gutter `+` draft** (`useForcedCaretQuery`): `useInsertBlockBelow` inserts an
  empty paragraph below, focuses it, and flags it via `requestBlockMenu(newId)`;
  that block force-opens the same menu with its OWN text before the caret as the
  inline filter (placeholder "Type to filter"). On commit the filter text — never
  content — is dropped and the block converts. Esc / outside-press keeps the block
  and clears the draft, so `+` then Esc is "new empty line below" rather than a
  click that did nothing.

`blockMenuDraftId` on the context is the single source of truth for the draft's
open-state, so the flag and the menu can never disagree. The draft is born as the
type declaring `defaultText` (`page/text`), resolved via `defaultTextHandle` — the
editor core never names a block type.

There is deliberately **no bottom "Add block" button** (Notion has none either).
Every way to create a block already runs through a real block with a caret — the
gutter `+`, `/`, Enter, and the Notion-style click on the empty background below
the last block (`onEmptyClick`). A "pick, THEN create" popover would need its own
`SearchInput`, having no block/caret to filter inline. The turn-into menu is not
one of those: it renders `BlockTypeList` inline in the block-actions popover, over
a block that already exists.

Commit is `insertAfter` + `convertTo`, i.e. two undo entries (undo once → back to
a paragraph, twice → gone). Deliberate: the paragraph genuinely existed.

**`Editor.InsertAction` — entries that RUN rather than convert** (`/agent-page`:
a server op that turns the line into a kind of page). Listed in the same menu,
ranked by the same `filterInsertEntries`, and placed by `after: <block type>`
(the config orders block types only; an action with no placeable `after` gets a
trailing section, never dropped). Committing one strips the query through
`stripText` — `convertStrippingText`'s doc half alone — then calls `run`, handing
it the line's text with the query cut out (`runsWithoutSpan` over the live runs:
the strip lands only after the menu's own update, so nothing else says it yet),
so an action replacing the line carries the user's words over. Offered
only on a `serverSync` editor with no `enabledBlockTypes` allowlist (the
`TurnInto` gate), and only once the line is `rowTruthOf === "present"`: the
gutter `+` opens the menu on a paragraph it inserted optimistically, and a
server op on a row the server does not have yet 404s. The turn-into picker lists block types only: an action does not
convert. Rows are `InsertEntry`s (`{kind: "block"} | {kind: "action"}`), and
`BlockTypeList` is generic over the kind, so turn-into's `onSelect` sees block
entries only.

## Indent / outdent is a set operation

`BlockOp`'s `indent` / `outdent` carry `blockIds: string[]`, not one id. Tab inside
a block's text editor is simply the one-element case; Tab in block-selection mode
passes the selection roots. One op kind, one reducer, one server handler — the
optimistic overlay, the undo record, and the notify path all follow for free.

The two folds run in **opposite directions**, and that is what makes a selection
move as one rigid body rather than collapsing into a nested chain:

- **`foldIndent` — top-to-bottom.** A successful indent removes the mover from its
  sibling list, so the next selected sibling's previous sibling is that same new
  parent and the run lands as consecutive children of the block above it. The guard
  is the other half: a block whose previous sibling is *itself a selected block that
  stayed put* refuses to move, so a leading block that cannot indent holds its whole
  run in place. Skipping cascades; a fully-refused op is an identity no-op.
- **`foldOutdent` — bottom-to-top.** `outdentOne` adopts the followers left below
  the block (Notion's outdent; never out of a container — see *An outdent never
  splits a container*). Bottom-up, every selected follower has already left
  by the time an earlier block moves, so only UNSELECTED followers are adopted, by
  the last selected block. Top-down, the first block would swallow the rest of the
  selection as children.

Ranks are only comparable within a parent, so the folds sort their input with
`documentOrder` (a rank-ordered DFS), never the caller's array order or a global
rank sort.

`dispatchOp` drops any op whose reducer diff is empty, so a refused Tab never
reaches the undo stack, the overlay, or the network. `canIndent` / `canOutdent`
run the same fold to drive the selection bar's disabled state — the affordance can
never disagree with what the key does.

## Undo / redo (one unified stack)

The editor **does not own the stack**: `<UndoRedoProvider>`
(`@plugins/primitives/plugins/undo-redo/web`) is mounted once per surface tab by
`apps-core/tab-surface` and the editor is one participant recording into it,
alongside the Pages sidebar. One document-level stack covers BOTH text and
structure — no per-block Lexical history.

- **The editor's entries are mount-scoped.** `BlockEditorProvider` records through
  `useScopedUndoRedo()`, so its entries drop off the stack when the editor unmounts.
  Required, not cosmetic: its thunks close over the per-`pageId` optimistic store
  and its row truth, which die with the editor — so replaying one after unmount
  would be a patch into another page's overlay at worst. Net effect: after
  navigating away, Cmd+Z does not reach back into the old page. Entries whose
  thunks are pure server calls (the sidebar's trash-restore) are unscoped and
  survive. (Making the editor's entries mount-free is a recorded follow-up; the
  entries themselves are already self-contained data.)
- **One stack, surface-level router.** There is deliberately no Lexical
  `HistoryPlugin` — a per-block parallel history is a layering error: the
  `page_blocks` row tree, not a Lexical document, is the source of truth. Cmd+Z /
  Cmd+Shift+Z / Cmd+Y are NOT routed per-block and NOT registered by the editor:
  `TabSurface` mounts one `useUndoRedoShortcuts()` per tab (`surfaceId`-gated,
  `enableInInputs`, on the window-level `ShortcutManager`), so the sidebar and the
  body cannot race for the same key id. Nothing in the container `onKeyDown`
  consumes those keys, so the native keydown bubbles out untouched and
  text/structure interleave chronologically.
- **The block list CLAIMS those keys, it does not inherit them**
  (`surfaceUndoProps` on the interaction container). The binding yields to any
  text field keeping its own history — otherwise ⌘Z in the agent prompt beside an
  open page undoes the prompt AND the page. Focus on `<body>` (where a structural
  undo leaves it) still resolves to the surface, so the old focus-independence
  this relied on is preserved where it mattered. See `primitives/undo-redo`'s
  *This stack is not the only undo history on screen*.
- **Text edits are DATA entries: a block's runs before and after one typing
  run.** Each block's run tracker (see the CRDT section) closes a run after a
  500 ms idle window and `recordTextEdit` records it as `{blockId, before,
  after}`; replay brings the block back to those runs on whichever host holds
  it then. There is no `data.text` autosave path — rows receive text only
  through the debounced doc→`data.text` projection.
- **ONE recorder, command-pattern patches, not snapshots.** Every entry goes
  through `recordEntry({label, focusId, before, after, runsEdits?,
  coalesceKey?})` in `block-editor-context.tsx`: it seals every open typing run
  first (a structural op never records ahead of the run that preceded it),
  snapshots `before`, computes `after`, `diffBlocks` (pure,
  `core/block-diff.ts`), derives minimal forward/reverse `BlockPatch`es, pins
  every removed row's text to its doc, and `record`s thunks that re-apply them
  onto the CURRENT state — so undoing an old action never clobbers later
  unrelated edits. Undo replays each runs edit's `before` THEN dispatches the
  reverse patch; redo dispatches the forward patch THEN replays each `after` —
  a doc edit always runs while its row exists. `recordStructural` /
  `recordTextEdit` / `recordDocEdit` are thin wrappers (structural ops never
  coalesce).
- **One single-row chokepoint (`commitRow`).** It snapshots rows, applies the
  transform to just that row, diffs into a minimal patch pair, optionally records
  it, then dispatches forward through the optimistic pipeline. `projectText`,
  `BlockEditorAPI.update`, `convertTo`, and `setExpanded` are thin callers, so
  forward apply and undo/redo are symmetric by construction and a new block type's
  `editor.update(...)` is recorded automatically. (Multi-row structural ops go
  through `dispatchOp` + `recordStructural`.)
- **Same optimistic instance.** The `patch` overlay variant flows through the SAME
  `useOptimisticResource` as forward ops, POSTing to
  `POST /api/pages/:pageId/blocks/patch` (`handle-patch-blocks.ts`, a blind
  row-level create/update/delete writer sharing the op handler's delete-lifecycle
  and notify path). Undo/redo thunks dispatch patches DIRECTLY, never through the
  recording wrapper, and the primitive's re-entrancy guard ignores `record` during
  replay. Bound editors never re-read `data.text` from a patch — content flows
  exclusively through the block's `Y.Doc`.
- **Two patch predicates, deliberately asymmetric** (both in
  `internal/optimistic-block-ops.ts`). `isPatchAbsorbed` is the APPLY-GUARD — "would
  writing this onto THIS base change anything" — and must be exact, `data` INCLUDED:
  a data-only edit (to-do `checked`, callout color) is a real edit, and a data-blind
  guard swallowed every one of them in memory mode. `isPatchReflected` is
  CONFIRMATION — "does server truth prove my write landed" — and must NOT compare
  `data`: `parseBlockData` normalizes it and `data.text` trails the doc by ~1s, so a
  snapshot that provably contains the write can still differ, and comparing would
  stick the op in the overlay. Same question, different subject; don't merge them.
- **A create of a row this client has SEEN in server truth is a restore, and a
  restore is judged by presence alone — under both predicates.** Every delete is
  a trash, so a patch `create` whose id matches a trashed row restores the
  STORED row and the server ignores the create's fields (re-ranked after a slot
  occupant, reparented to the root, expanded if toggled between delete and undo).
  Comparing those fields is the `data` mistake again, with no later push to
  rescue it (the restore ran in its own transaction; the patch wrote nothing):
  the op sat in the overlay painting the recorded collapsed toggle over the
  server's expanded one until an unrelated write moved it. The patch variant
  carries `restoreIds` — derived at the ONE dispatch chokepoint (`dispatchPatch`)
  as the creates whose `RowTruth` is `"removed"`, never chosen per call site —
  and for those ids `isPatchReflected` / `isPatchAbsorbed` ask only "is the row
  there", while `applyPatch` inserts the recorded copy only while the row is
  ABSENT and keeps a present row as it is. A client-minted id (`"unseen"`) is
  never in the set: a genuine create keeps its full field comparison. Pinned by
  `optimistic-block-ops.test.ts`'s *restore creates are presence-only*.
- **A patch's delete cascade reads POST-patch parentage.** The writer closes the
  delete set over the forest as the patch leaves it (each update's NAMED
  `parentId` applied), so a row the same patch re-parents out of the deleted
  subtree stays live; `applyPatch` must agree or the overlay drops rows the
  server keeps (redoing an `unwrap` lost every promoted child). A patch naming
  one id both as a write and in `deleteIds` is a 400.

**What is recorded:** all `dispatchOp` ops — which is now every structural
mutation, `paste` / `duplicate` / `move` / `delete` / `bulkMove` included, and
`splice` through its own executor (structural patch + origin `runsEdits`, or
one text entry when it creates no row) —
plus `convertTo` and non-text `data` edits (to-do `checked`, callout color, image
src… — via `commitRow` with `coalesceKey: blockId`), each with an exact
purely-computed after-state; text edits as the run tracker's data entries. The
editor no longer uses `updateBlock` at all (`handle-update-block.ts` stays for
page-level consumers: page title, sidebar expand, cover).
`web/__tests__/structural-undo.test.tsx` is the per-mutation guardrail, asserting a
QUADRUPLE per mutation: the forward call changed the rows, `canUndo` flipped, undo
restores exactly, redo reproduces. The first is not ceremony — without it a
mutation that silently does nothing passes vacuously, which is how the data-blind
apply-guard hid. **There are no exceptions left to enumerate**: every mutation
reachable from the editor's context is in that table.

**Not recorded, and only these two:** `setExpanded` (pure view state,
`record: false` — Notion doesn't undo collapse/expand; still optimistic, just off
the stack) and `projectText` (Yjs owns text history).

## Drag and block-selection writes are ops too

`move`, `bulkMove` and the bulk `delete` were fire-and-forget POSTs to bespoke
endpoints — no overlay (their eslint-disables read *"drag again to fix"*), no
place in the write order. They are now `BlockOp`s, so DnD is optimistic and the
two bulk endpoints are deleted. What each one had to keep:

- **`move` sends POSITIONAL INTENT, never a rank**: `{ blockId, parentId,
  targetId, zone }`. `page_blocks` has ONE `(parent_id, rank)` space that several
  live resources project disjointly, so a key minted over the rows one writer
  holds collides with the siblings it cannot see. Both sides mint their own from
  `positionalRank` (`core/block-forest.ts`) and the server's stays authoritative
  — the agreement `split` and `paste` already run under.
- **That agreement needs the destination inside the op's own page**, which the
  server enforces with a 400 (`assertDestinationInPage`). A **cross-page** drop
  is not one page's op — the row leaves the source page's resource entirely, so
  no per-page overlay could ever confirm it — and keeps the id-scoped `moveBlock`
  endpoint (which locks both forests), enqueued on the source page's lane.
  `moveBlock` also stays alive for the Pages sidebar, a different surface over
  the `docRank` order.
- **`delete` is a SET** (`blockIds`), like `indent`/`outdent`: one gesture is one
  op, one undo entry, one transaction. A single Backspace-delete is the
  one-element case. It is the only op that may span pages, and the composite
  fans it out per owner (`splitOpByOwnerPage`).
- **`bulkMove`** carries `{ ids, parentId, afterId }` and reduces through
  `planBulkMove`; a refusal is the identity, so a refused drag never reaches the
  undo stack or the network. A **cross-page** selection drop (into an expanded
  sub-page, or out of one) is not a `bulkMove` op, for `move`'s reason: the
  composite routes it to the id-scoped `moveBlocks` endpoint
  (`POST /api/blocks/move-many`), which locks both forests, runs `planBulkMove`
  against the destination's complete live sibling set and re-scopes each root's
  `page_id`, in one transaction. `resolveOpOwnerPage` throws on a `bulkMove`
  whose destination is another page, so one can never reach a page's lane — it
  used to, and the op endpoint's 400 left it rendered but unsaveable.
- **A cross-page move asks the DATABASE whether it is a cycle**
  (`server/internal/ancestry.ts`): a dragged sub-page's content is keyed to that
  sub-page, so a page-scoped forest cannot see a destination inside it. Both
  `moveBlock` and `moveBlocks` walk the destination's ancestors.

## With nothing selected, the caret's block IS the selection

The clipboard has two surfaces — block-selection mode's container
(`block-editor.tsx`) and the caret inside one block (the two Lexical plugins) —
and the caret one used to be paste-only. A `copy` with a collapsed caret reached
`@lexical/rich-text`, which had nothing selected to copy, and did nothing at all.

`BlockForestCopyPlugin` states the missing half as one rule:

> With NOTHING selected, the caret's own block IS the selection.

So Cmd+C copies that block and its subtree, Cmd+X copies and removes it, and a
caret Cmd+V of that payload lands it as WHOLE blocks right after the caret's line
— its payload says it was copied whole (`granularity: "blocks"`, see *A paste
lands AT the insertion point*), so it is never merged into the caret's text.
"Copy, paste, duplicated" is two keystrokes without leaving the text. **A non-collapsed selection declines** (`return false`), so a real text
range is still the browser's own inline copy, marks and all; the only case
claimed is the one where the native gesture was a silent no-op. Both plugins sit
at `COMMAND_PRIORITY_NORMAL`, above rich-text's `COMMAND_PRIORITY_EDITOR`
handlers.

- **One encoding, two surfaces.** `writeForestToClipboard`
  (`internal/clipboard-write.ts`) is the sole writer of a copied forest —
  `BLOCKS_MIME` for the structural round-trip plus a `text/plain` markdown
  fallback — so the container copy and the caret copy produce byte-identical
  payloads by construction rather than by two implementations agreeing. It is
  the inverse of `decideTransfer`'s `forest` arm and lives beside it, but NOT in
  `internal/transfer.ts`: that module stays loadable with no Lexical in the
  path, which is what lets `transfer.test.ts` unit-test the decision.
- **A cut deletes only on the branch that copied.** `CUT_COMMAND` runs the same
  writer and calls `editor.remove()` — the rail menu's own Delete op, so the
  caret lands where a delete always lands and the cut is one undo entry — but
  only when the write returned `true`. A cut that never reached the clipboard
  must not destroy the block.
- **It copies the block the CARET is in, never the container around it.** The
  rail's menu resolves to `RailSeat.owner` instead (a callout's borrowed line
  acts on the callout); the keyboard acts on the line you are standing in. The
  split is deliberate — copying a whole container is what selecting it as a
  block is for, and *selecting every line it owns* is how you do that (see
  *Selecting every line a container owns IS selecting the container*).
- **`serializeForest` reads the ROW, not the live `Y.Doc`**, so a copy fired
  inside the ~1s `data.text` projection window carries the pre-keystroke text.
  Inherited from duplicate, which has the same bound; `e2e/caret-clipboard-verify.ts`
  waits it out rather than pretending it isn't there.

`e2e/caret-clipboard-verify.ts` is the executable spec: the bare-caret copy
against a sentinel clipboard (a stale value IS the pre-change symptom), the
paste-duplicates-it pair, the subtree travelling with its parent, the text-range
copy staying inline, the cut, and (phase F) the one-step gesture copied with
**no settle** — there the timing IS the assertion, and a settle would silently
re-test phase D.

### "Nothing selected" is a question for the DOM, not for Lexical

> A clipboard handler asks `selectionIsCollapsed()` (`primitives/dom/dom-selection`)
> and claims only when the model and the document AGREE that nothing is
> selected. **Lexical's model cannot answer this during a copy**: its
> `$internalCreateRangeSelection` re-derives from the DOM only for an
> allow-listed event set — `selectionchange`, `beforeinput`, the composition
> events, a triple `click`, `drop` — and hands back `lastSelection.clone()` for
> everything else. `copy` and `cut` are everything else.

So the model in a copy handler is whatever the last sync left, with no way to
recover if that is out of date — and it goes out of date under rapid input,
because `selectionchange` fires in a LATER task than the keystroke that moved
the selection. That combination is the whole of the whole-line copy bug, and it
is worth stating because the symptom points nowhere near the cause:

- **The damaging shape is a selection made in one step** — `Shift+Home`,
  `Shift+End`, `⌘A`, a drag, a triple-click — because only then does "stale"
  mean COLLAPSED: the document plainly has a highlight while `isCollapsed()`
  says nothing is selected. `⌘C` in that window read as "nothing selected", so
  the plugin copied the whole BLOCK — and `BlockForestPastePlugin` then landed
  it as a new block BELOW, which is what the user saw instead of their text
  arriving inline. `⌘X` would have deleted the block.
- **Only the FIRST step of a gesture has that shape.** From the second
  `Shift+Arrow` on, the model is merely one character behind rather than
  collapsed, so the decline is correct. That asymmetry is why the defect reads
  as "only whole-line selections are wrong", and why it reads as a PASTE bug:
  the paste was faithfully landing what the copy had put on the clipboard.
- **Disagreement declines**, never claims. The worst case on that branch is a
  bare-caret copy falling back to the native no-op; the worst case on the other
  is a block copied — or cut — that the user never selected.

## A block is ONE paragraph, and a paste cannot make it two

A block is its own row, its own content doc, its own Lexical editor with a
single-element root. Nothing in normal use can put a second paragraph in that
root: Enter is a structural `split` op that mints a real sibling row and
truncates this one, and Shift+Enter inserts a `LineBreakNode` INSIDE the
paragraph. Every caret, split and merge rule in this plugin is written against
the absence of that state. The one path that could produce it was a clipboard
insert, and nothing guarded it.

`BlockClipboardInsertPlugin` states the rule at
`SELECTION_INSERT_CLIPBOARD_NODES_COMMAND`, Lexical's own seam for "what does
this editor do with clipboard-generated nodes?".
`$insertDataTransferForRichText` dispatches it for whichever MARKUP flavor it
parsed (`application/x-lexical-editor`, `text/html`) and for every gesture that
reaches that function — paste, drop, and the controlled text insertion behind an
IME. Guarding there rather than at `PASTE_COMMAND` is what makes the rule hold
across all of those instead of the ones we happened to list.

- **It claims only a payload that actually carries block structure.**
  `isBlockLevel` is `RangeSelection.insertNodes`' OWN predicate for taking its
  paragraph-splitting branch, so the guard tests exactly what it guards against.
  An all-inline payload — the overwhelmingly common case — declines, and the
  ordinary paste keeps Lexical's behaviour untouched. Where it does claim, it
  restates the one thing Lexical would have done afterwards: carrying the last
  pasted run's marks onto the caret (`$updateSelectionOnInsert`, not exported),
  so typing continues in the pasted format on BOTH arms.
- **Block structure can reach here even though `decideTransfer` already ran.** That
  classifier reads `text/plain`; `text/html` is written by whatever app the user
  copied from and need not agree with it. A single-line `text/plain` beside a
  multi-paragraph `text/html` is ordinary output from real editors, and it is
  the reachable case: measured against `lexical@0.44.0`, a lone `<p>hello</p>`
  merges into the caret's paragraph on its own, but `<p>a</p><p>b</p>` leaves the
  root with two.
- **A boundary with content on both sides becomes a soft break.**
  `$flattenToInline` unwraps each block element and emits a `LineBreakNode`
  lazily, only once something follows — which is what a line boundary inside a
  block already IS here. The lazy half is not a detail: a leading-edge-only rule
  fuses `<p>a</p>tail` into `atail`, and leaves a stray trailing break (and with
  it a trailing `"\n"` run, and the caret parked on a `<br>`) for the
  `<p>a</p><p></p>` that real editors emit. Nothing is dropped and no row is
  minted.
- **Three outcomes, three arms** (`InlineClipboardContent`), because an empty
  result and a refusal need different decisions and a bare array would let them
  ride together. `empty` — block structure carrying no content — still has to
  REPLACE what was selected, which `insertNodes([])` returns too early to do.
  `not-inline` is a non-inline DECORATOR: it owns no children to unwrap, so
  there is no inline form of it and dropping it would lose content — the plugin
  declines and Lexical's own insert runs exactly as before. No block-text node
  registers such a decorator today; the arm exists so adding one is a visible
  behaviour rather than a silent delete.

**The plain-text arm is closed by the OTHER half, not by this rule.**
`$insertDataTransferForRichText`'s third arm calls `selection.insertParagraph()`
per newline and dispatches no command, so no listener — this one included — can
reach it. It is unreachable *with a newline in it* instead: every gesture that
carries text into the page is classified before it can get there. So the
invariant stands on two legs, and both are needed to see the case is closed
rather than merely moved:

- the MARKUP arms (`application/x-lexical-editor`, `text/html`) are guarded
  here, at `SELECTION_INSERT_CLIPBOARD_NODES_COMMAND`, whatever the gesture;
- the PLAIN-TEXT arm is classified away before the gesture reaches it —
  `decideTransfer` sends text with a newline to a block forest on a caret
  paste (`BlockForestPastePlugin`, which SPLICES it at the caret), on a
  block-selection paste and on a DROP (the container, below).

## The transfer door (one classifier, two gestures)

> A `DataTransfer` entering the page is classified ONCE, by shape, and becomes a
> FOREST unless it is newline-free text AND there is an inline insertion point to
> take it. A forest at an insertion point is SPLICED there (see *A paste lands AT
> the insertion point*); without one it lands as blocks after the anchor row.
> Paste and drop run the same classifier; the only difference between them is
> where the insertion point comes from — the caret, or the pointer.

`internal/transfer.ts` is that classifier (`decideTransfer` → `file` / `forest` /
`markdown` / `inline`), and it stays Lexical-free so `transfer.test.ts` can
unit-test the decision. `readTransferText` is its one text read — `text/plain`,
else `text/uri-list`, byte-for-byte the fallback
`$insertDataTransferForRichText` uses (`@lexical/clipboard@0.44.0
LexicalClipboard.dev.mjs:121`), because a transfer describing a link ONLY as
`text/uri-list` is otherwise invisible to the classifier and lands in the arm
below it anyway.

**Ownership splits by what the gesture knows.** A block owns the caret PASTE; the
block-editor CONTAINER owns the pointer DROP, because a drop has a pointer
position and where a pointer position lands is container knowledge (`rowAtPointer`,
`externalDropPosition`, the per-row insertion line, the full-surface scrim).
There is deliberately **no per-block `DROP_COMMAND` handler** for the
forest/markdown cases — it would double-handle with the container's.

- **The container is a valid door because React's root-delegated listener runs
  during the native `drop`'s BUBBLE dispatch, i.e. before the default action.**
  `preventDefault()` there cancels that default action, and with it the
  `beforeinput` / `inputType: "insertFromDrop"` the browser would otherwise fire
  — which is the whole of the plain-text-arm fix, since that beforeinput is how
  the unreachable arm was being reached. The file drop has relied on this
  ordering in production since long before the text one did.
- **The dragover decision is TYPES-ONLY, and that costs something.** During a
  drag the `DataTransfer` is in protected mode: `types` is readable,
  `getData()` returns `""`. So `dragKindFromTypes` (`internal/drag-kind.ts`)
  answers only `files` / `forest` / `text` / `none` — it **cannot** tell a
  single line from a multi-line one. The consequence is visible: a TEXT drag
  over a block's own text shows no scrim and no insertion line, because we do
  not yet know whether it will land inline or as blocks. We decline the dragover
  there and let the contenteditable make the drop fire anyway; `onExternalDrop`
  reads the bytes and claims it only if it turns out to carry newlines — and
  then SPLICES it at the pointer: `insertionPointAt` hit-tests the block's own
  text (`BlockTextSurgery.offsetAtPoint`, the read half of
  `placeCaretAtColumn`'s hit-test, in the stored-runs basis) and reads its live
  runs. A drop the hit-test cannot place (no text surface under the pointer)
  lands as blocks at the pointer row, as a drop on the chrome does.
- **A Lexical-marked drag is never claimed.** `application/x-lexical-drag`
  (`$writeDragSourceToDataTransfer` on `DRAGSTART`) means the editor is MOVING
  its own nodes, with Lexical's own source-removal semantics — cut-and-paste, not
  copy. It is refused ahead of every other type it carries, since it rides along
  with the selection's own `text/plain`.
- **`inline` is a question the caller answers**, and it is the only difference
  between the two gestures: `true` for a caret-in-block paste and for a drop
  whose target sits inside a block's editing host (`isInsideEditingHost`, shared
  with the pointer-press gesture), `false` for the block-selection container
  paste (which deliberately holds no caret) and for a drop over the page's
  non-editable area. An `inline` drop is left entirely to the browser — no
  `preventDefault` — so a single line still lands at the drop caret exactly as
  it always did.
- **`inline` is "no newline", not "one parsed paragraph".** Text without a line
  in it cannot carry structure, so the native insert is exactly right for it —
  and keeping it native keeps url-paste, token-paste, `text/html` marks and
  `BlockClipboardInsertPlugin` working. Everything else at an insertion point
  is a splice, a lone `para⏎` included (a head-only splice: a text edit of the
  caret's line). Whatever the parse yields, the splice puts it AT the point, so
  "one parsed paragraph mistaken for structure" is no longer a class of bug.
- **A dropped URL gets the paste's treatment, and CONSUMES the gesture.**
  `page/url-paste` registers `DROP_COMMAND` beside its `PASTE_COMMAND`: a bare
  URL pasted at a collapsed caret in any text block — or dropped into an EMPTY
  one — becomes a link at once, with a Keep as link / Mention / Bookmark / Embed
  menu beside it (Bookmark and Embed only when the link is all the block holds).
  The drop keeps the empty-block gate because a drop into existing text lands
  where the browser puts it, not at a caret we hold. Because the container's
  drop door sits ABOVE it, that arm also
  calls `stopPropagation()`, and the reason is not defensive tidiness: a
  `text/uri-list` is CRLF-terminated (RFC 2483), so the payload a link drag most
  often carries is *literally* multi-line, classifies as `markdown` up at the
  container, and a single dropped URL would insert the link AND mint a block. Only
  DROP needs this — a caret paste never reaches the container's `onPaste`, which
  gates on the CONTAINER holding focus.
  - Note what is NOT done about that CRLF, and why: `decideTransfer` reads the
    RAW text, trailing terminator and all, because the arm it declines INTO
    reads the same raw text — a classifier that trimmed first would call a
    CRLF-terminated URL "one line", hand it to the native insert, and that
    insert would split the root on the very terminator we trimmed. So a
    `uri-list`-only transfer dropped into ordinary text becomes its own block.
    That is the safe reading, and the common case never reaches it: a real link
    drag also carries a terminator-free `text/plain`, which `readTransferText`
    prefers.
  - Its one bound is focus — a drop need not have focused the editor, so it
    seats the caret at the (empty) block's start and calls `lexical.focus()`.
    A root with no children (a block whose content doc has not hydrated yet)
    has nowhere to seat it, so the drop arm declines there and the gesture
    falls through.

Spec: `e2e/drop-verify.ts` and `page/url-paste`'s `e2e/url-drop-verify.ts`
(manual), plus `transfer.test.ts` / `drag-kind.test.ts` for the two pure
decisions.

## Paste is an op (`{ kind: "paste", forest, afterId, parentId }`)

Paste was once the ONE editor mutation outside the optimistic pipeline — a
bespoke `POST /blocks/paste` the user waited on. A 25-block paste took 561-789ms
to first pixel with a ~500ms main-thread freeze; it read as the app hanging.

The load-bearing idea, and the thing not to undo:

> **Identity is minted client-side and travels ON the node.** `withMintedIds`
> (`core/serialized-block.ts`) turns `SerializedBlock[]` into
> `IdentifiedBlock[]`, and `planForestInsert` consumes those ids rather than
> minting its own — the same agreement `split`/`insert` get from `newId`. With
> ids agreed, both sides run the same planner and produce the same rows; ranks
> still differ per side and the server's stay authoritative, as for every op.

Ids ride the node rather than a parallel `ids: string[]` **because a positional
array breaks silently**: reorder a traversal on one side and the two sides insert
*different blocks*, so the op can never confirm.

- **One write path for a forest insert.** Both the `/blocks/paste` and
  `/blocks/bulk-duplicate` endpoints are deleted, and nothing on the server
  mints a forest's ids any more.
- **Anchorless paste inserts at the START of `parentId`**, where anchorless
  `insert` appends. Inherited from the old endpoint's contract; only reachable on
  an empty page, since real callers resolve an anchor via `pasteAnchorId`.
- **`OpEffect.create` carries `ids: string[]`** — ROOT ids only. The forest lands
  in ONE transaction, so a root's presence implies its descendants'; listing every
  node would grow the confirmation scans with the paste for no extra power.
  `opNamedIds` makes the same call, and it is a statement about NAMING only: the
  rows a paste actually wrote are `writtenIds`' answer, which does list the whole
  forest, and that is what reaches the op's `targets`.
- **A missing anchor refuses the whole paste** (as `applyInsert` does for a
  missing `afterId`) — guessing another parent would drop content somewhere the
  user never asked for.
- `insertScopePageId` is shared by `applyInsert`/`applyPaste` — one page-scope rule.
- **`paste` is the op WITHOUT an insertion point** — the block-selection
  container paste (no caret) and a drop outside any text. A caret paste and a
  drop into text are `splice`s, below; both mint through the one
  `prepareForest` (`withPasteIds` + `claimCutPages` + `markCutsPasted`), so the
  cut-sub-page rules cannot differ between them.

`e2e/paste-optimistic-verify.ts` is the executable spec and does NOT trust
latency: it stalls the op endpoint 4s and asserts the blocks render long before
the server could answer, one op POST fires, the push neither duplicates nor drops
them, and they survive a reload.

### A paste lands AT the insertion point (`{ kind: "splice", … }`)

> A forest pasted or dropped at an insertion point inside a block's text is
> SPLICED there: the text before the point keeps its line and absorbs the
> forest's leading paragraph; the text after the point goes to the end of the
> forest's last paragraph; everything else lands in between. One op, one undo
> entry, and client and server compute the same rows.

It used to be a `paste` AFTER the caret's block, so every multi-line paste landed
in the wrong place: `The plugin system⏎` into an empty line left that line empty
above a new block; `a⏎b` at `foo|bar` gave `foobar`, `a`, `b`. The op
(`core/block-ops.ts`, planned by `planSplice`) is split and paste fused —
`runs`/`position`/`siblingType`/`tailData`/`tailId` mean what split's
`runs`/`position`/`siblingType`/`tailData`/`newId` mean, and `forest` is
paste's, ids minted client-side. With `[before, after] = splitRuns(runs,
position)`:

1. **Head.** A leading PLAIN paragraph — `BlockOpContext.defaultTextType`
   (derived from the registry's `defaultText` handle, never named); nothing else
   has an inline form — merges into the origin: `before + head`. Lines nested
   under it become the origin's first children, so a partial copy's nesting
   survives.
2. **Text only.** Nothing left over: the origin reads `before + head + after`.
3. **Consume an empty origin.** Textless (no `before`, no head merged), plain,
   and childless: the forest takes its slot, so `# Title⏎body` into an empty line
   leaves no blank line above the title.
4. **Body.** The rest lands where split puts its tail — `splitSlot`, the one
   placement rule the two ops share: the origin's next siblings, or, at the END of
   a line whose children are visible (where Enter nests), its first children.
5. **Tail.** A non-empty `after` goes onto the forest's LAST LINE (its last
   root's deepest last descendant, or the merged head's) when that is a plain
   paragraph, at any depth — so a multi-line partial copy pasted mid-line joins at
   BOTH ends (`zz|zz` + `aa` › `bb` → `zzaa` › `bbzz`; it used to split the
   caret's line around whole blocks, because a first or last root WITH children
   never counted as plain). Else onto a tail row `tailId` of split's type and
   data. The root holding it adopts the origin's visible children after its own,
   as split's tail does.

**What the forest was copied AS decides how it meets the line** — the op's
required `granularity` (`ForestGranularity`), never inferred from the forest's
shape (one copied paragraph and one pasted line of text parse to the same node):

> A block copied WHOLE pastes as whole blocks — never merged into the caret's
> text. Text (external text, markdown, a text range) is spliced into it.

- **The copy states it; the payload carries it.** `BLOCKS_MIME` is an envelope,
  `{ granularity, forest }` (`encodeBlocksPayload` / `decodeBlocksPayload`,
  `internal/transfer.ts`). Its only writer, `writeForestToClipboard` — the
  block-selection copy and the bare-caret whole-block copy — writes `"blocks"`;
  a text-range copy is the browser's and writes no `BLOCKS_MIME` at all. A
  pre-envelope bare array decodes as `"blocks"`, which is true of every one ever
  written. Markdown and plain text reach the doors as `"text"`.
- **Two placement rules, one per granularity.** `"text"` lands where a SPLIT puts
  its tail (`splitSlot`, steps 1–5 above) — the text after the point travels with
  the forest, so it needs split's adjacency. `"blocks"` lands where a PASTE puts a
  forest (`insertForestAt` after the origin, i.e. after its whole subtree) with no
  head and no tail merge (`planWholeLines`) — nothing is split. Both consume an
  empty, plain, childless origin, so pasting into an empty line replaces it, and
  a selected range is replaced either way (the origin takes `runs`, span cut).
  It is one op with a mode rather than a routing to `paste`, because the
  consumption and the range replacement are the insertion point's, and `paste`
  has no insertion point.

The caret lands at the end of what was pasted (`planSplice`'s `caret`: the
holding line at `runsLength(line) - runsLength(after)`), and `opFocusId` reads
the same answer for undo/redo. Refusals are split's (page row, anchor, text-less
row) plus paste's missing anchor — the origin IS the anchor.

**Text follows split's row/doc division.** Only the ORIGIN has a live `Y.Doc`,
so the executor (`BlockEditorContext.splice`) dispatches the op, lands the caret
on the new last line (a claim, like `focusNew`), and one microtask later brings
the origin's doc to the text the reducer left on its row — `spliceOpenBlockDoc`
inside the owner's `untracked` scope — recording BOTH on one entry (structural
patch + origin `runsEdits`). Every other row is new and seeds from its creation
`data.text`; the server writes rows only, as for split. A CONSUMED origin gets no
doc edit (its row is trashed; `pinRestoredText` pins it for undo). A missing live
owner throws: a splice only ever comes from a mounted text surface.

**A splice that creates no row is not dispatched.** A single-paragraph paste is a
text edit of the origin, and an existing block's text is doc-owned (*Text is
doc-owned*) — so it is `recordDocEdit`'s one data entry, and no row op carries
it. That is also what keeps the op's effect honest: `OpEffect.create` lists the
rows the splice really CREATED (measured, so an absorbed head is never in it),
and a dispatched splice always creates at least one.

- **Inside a zoom, the root keeps its own rule.** The root's next siblings are
  outside the view, so a splice on the root line would be refused whole; it
  pastes as the root's first children instead (the text stays where it is).
- **A stale model selection is Lexical's, not ours.** A paste is not in
  `$internalCreateRangeSelection`'s DOM-resync allow-list (see *"Nothing
  selected" is a question for the DOM*), so a paste fired in the same task as a
  one-step selection gesture reads the pre-gesture caret — exactly as Lexical's
  own native paste would.

Spec: `core/block-ops.test.ts`'s `splice` suite, `structural-undo.test.tsx` (one
entry, doc and rows together), `e2e/copy-paste-verify.ts` phases H–J and
`e2e/drop-verify.ts` phases A and E. Design:
[`research/2026-09-29-page-paste-splice-op.md`](../../../../research/2026-09-29-page-paste-splice-op.md).

### Duplicate is copy + paste-in-place (`{ kind: "duplicate", placements }`)

Same op machinery, one gesture = one op = one undo entry however many roots:
each placement clones one selection root and lands it right after that root, and
the reducer arm is literally paste's (`insertForestAt`, shared). `serializeForest`
(`web/serialize-blocks.ts`) is the ONE forest serializer — copy and duplicate use
it, so "duplicate ≡ copy then paste after the source" is true by construction
rather than by two mirrored implementations agreeing.

- **A distinct op kind, not a fatter `paste`**, because `OP_LABELS`/`opFocusId`
  are keyed by kind: a duplicate must not read "Paste blocks" in the history.
- **A dead anchor drops only ITS placement**, where paste refuses the whole op.
  Paste's refusal is about not guessing a destination; a duplicate placement names
  its destination explicitly and independently. All-or-nothing would only ever
  fire server-side (the client built the op from rows that contain every anchor),
  so it would widen the never-confirming set from one clone to all of them.
- **Placements carry no `parentId`** — a clone always lands after its source, so
  the destination is never anchor-less. Keep it that way: `translateOpForStore`
  rewrites `parentId` only for the kinds that have one, so adding the field would
  silently skip anchor translation in an expanded sub-page.
- Placement order is not load-bearing (the array travels on the op, both sides
  fold it identically, and a clone always lands strictly between its source and
  that source's next sibling) — it is document-ordered for determinism only.

### A pasted sub-page moves once, and copies after that

A sub-page's content is not in the forest a copy serializes — it lives in the
page's own `page_id` partition, which the editor on screen never loads. So a
`type="page"` node carries `pageSource: { pageId, cutId? }` instead of children
(`core/serialized-block.ts`), and the server resolves the content when the paste
or duplicate lands, inside the op's own locked transaction
(`server/internal/page-clipboard.ts`):

> A page node whose id IS its source page is a CLAIM: the page itself moves.
> Any other page node is a COPY of the source's whole content.

- **The decision is the client's, made before dispatch**, because the paste
  renders optimistically under the ids it names and the server cannot pick a
  different identity afterwards. A cut stamps one `cutId` on its page nodes
  (`writeForestToClipboard(…, "cut")`); `paste` mints through `withPasteIds`,
  which keeps the source id only for a cut not yet pasted
  (`web/internal/cut-claims.ts`, remembered in localStorage and in memory) whose
  page is not already in the destination forest. `withMintedIds` stays
  unconditional, so duplicate always copies.
- **A claim keeps everything keyed on the page's id** — links, history,
  authorship, its content partition. The writer places the stored row where the
  reducer planned it (`writeForestTarget`'s `claims`) instead of inserting, and a
  trashed claim takes back only the rows under that page from the cut's entry
  (a cut of `[paragraph, page]` leaves the paragraph trashed). A claim of a page
  that is live elsewhere just moves it. A claim of the destination or a page
  above it is a 409.
- **A copy runs `BlockLifecycle.OnCopy`** over every `(source, copy)` pair, in
  the transaction, so a plugin keying state by block id brings it along without
  the writer naming it: `editor-collab` copies the content doc (the text's owner,
  which the ~1 s `data.text` projection may trail), `authorship` copies the
  conversations that wrote it. State that is a statement about the SOURCE row (a
  star, a TODO's task binding, the agent-origin marker) does not contribute.
- **Which rows are content follows the source page's own state**: a live page
  copies its live rows, a trashed one the rows its delete trashed with it. Rows
  this same write inserted are never read back as source, so pasting a copy of a
  page into that page terminates.

## A write names the fields it changes (`BlockPatch`)

> Restating a whole row asserts authority over fields you don't own.

`BlockPatch` is therefore an explicit create/update split, not an upsert
(`core/block-diff.ts`):

```ts
type BlockFieldChanges = Partial<Pick<Block, "parentId"|"type"|"data"|"rank"|"expanded">>;
interface BlockPatch {
  creates: Block[];                                    // full rows — a new row has no prior state
  updates: { id: string; changes: BlockFieldChanges }[];
  deleteIds: string[];
}
```

Two invariants fall out, and both used to be hand-maintained approximations:

- **A single-field writer cannot clobber a field it doesn't own.** `diffBlocks`
  reduces a whole-row `after` to `changedFields(before, after)`, and
  `patchesFromDiff`'s undo inverts *exactly that field set* — so a text
  projection authors `data` and says nothing about `type`. It is `commitRow`'s
  structural half: its callers still write `b => ({ ...b, data })`, but the diff,
  not the caller, decides what the patch claims. The incident: a projection flush
  firing from the unmount cleanup of a `/callout` conversion restated
  `type: "text"` over the callout the user had just picked. Reading render-fresh
  rows (`liveRowsRef`) narrows the window; the field scope removes it.
- **An update never creates**, which is what the retired `updateOnly` flag was
  approximating. An update naming a missing id is a skip *by definition* — in
  `applyPatch`, in `isPatchReflected` (vacuously absorbed, so the op confirms
  rather than replaying forever), and in the server writer. Only `creates` bring
  a row into existence, or back: a create whose id matches a soft-deleted row
  restores that row's WHOLE trash entry — every row the same delete flagged,
  page shell or paragraph alike — before the write transaction, consumes the
  entry, and is then excluded from the write (the stored row wins over the
  patch's copy, so a re-ranked or reparented root keeps its repair). Undo of
  any delete thereby restores the exact rows and their surviving content docs
  — and the client confirms such a create by the row's PRESENCE alone (the
  `restoreIds` on the patch overlay op; see the undo section).

Consequences worth knowing:

- **Both patch predicates compare exactly the fields the patch NAMES**, over one
  shared comparator, so a patch can never be produced by one definition of
  "changed" and judged by another (`data` deep-compared with `dataEqual`, the
  SAME predicate the diff used to emit it). They still differ on the one axis
  above — `isPatchAbsorbed` counts `data`, `isPatchReflected` does not.
- **The server writes only the named columns** (`handle-patch-blocks.ts`).
  `parseBlockData` validates against the *effective* type, so a `data`-only
  change validates against the STORED type, and a `type`-only change
  re-validates (and re-mints) the stored blob against the NEW one. The
  page-type transition guard keys off writes that name `type`; `parkRanks` only
  runs for writes that name `parentId` or `rank`.
- **An update carries no `pageId`**, so the composite store resolves its owning
  page from the union rows (falling back to its cumulative row→page index for
  rows that left with a collapse) — `groupPatchByOwnerPage`. Creates still route
  by their own denormalized `pageId`, which is what makes the detached-persist
  path work for a collapsed page.

### Every block delete is a trash (server)

> No write shape ever `DELETE`s a row the user can see. A delete flags its rows
> under ONE ledger entry per gesture; the real `DELETE` runs only at purge
> (30 days, or "Delete permanently").
> `research/2026-09-09-page-data-based-text-undo-entries-v2.md` §3.

Until 2026-09-09 a page-free delete was a hard delete, and the row's content doc
cascaded away with it; undo re-created the row and re-derived a doc from the
~1 s-lagged `data.text` projection, which under load raced to an empty seed —
a to-do came back without its text. Now:

- **Two sources, one mechanism.** A `type="page"` root mints its own `pages`
  entry (what the Pages Trash lists); every other row of the operation folds
  into ONE anchor entry — the first page entry when there is one, else a fresh
  entry in the `page-blocks` source (`PAGE_BLOCKS_TRASH_SOURCE`, undo + purge
  only, no UI), labelled by the first root's first line and carrying
  `{pageId, rootIds, count}`. One gesture is one undo. A page nested under a
  deleted non-page root anchors a `pages` entry on that root, so it stays
  findable in the Trash.
- **Where the trash happens.** A page-free set is trashed INLINE in the write
  transaction (`trashDeletedRows` in `forest-writer.ts`, both write shapes),
  so the hot path stays one transaction; a set containing a page row is
  deferred to `deleteBlocksSubtree`, which takes the sub-pages' own locks.
  Either way the set is CLOSED under descendants under the lock — a trash flags
  exactly the ids it is handed, and a descendant left live under a trashed
  parent is unreachable by any read.
- **Closed over the forest AS WRITTEN, and trashed before placing.** The
  closure takes each surviving row at the NEW parent this write gives it, so a
  child the same write re-homes out of a deleted block (`unwrap`, a merge's
  adoption, the redo of either) stays live, while an orphan a buggy write leaves
  under a deleted row is still trashed. The inline trash runs before `parkRanks`
  / insert / update: the live unique indexes are partial on `deleted_at IS
  NULL`, so a flagged row vacates its `(parent_id, rank)` slot for a row landing
  exactly there. The deferred branch trashes after commit, so it keeps that
  collision (no caller hits it).
- **The ledger invariant: an entry exists ⇔ at least one row carries its id.**
  Flags are set only by `trashBlockRoots` in the same transaction as
  `recordTrashEntry`, and cleared only by `untrashBlocks`, which deletes its
  entry in the same transaction. The `page_blocks_trash_flags_agree` CHECK
  (`(deleted_at IS NULL) = (trash_entry_id IS NULL)`) rejects the half-states.
  There is no "un-trash" bucket in the patch writer: clearing flags without
  consuming the entry is exactly what the invariant forbids.
- **Restore repairs only what the world changed.** A restored root keeps its
  stored row; a `(parent_id, rank)` slot a live sibling took is repaired by
  re-ranking right AFTER the occupant (`rankAdjacentTo`), and a vanished parent
  reparents to the workspace root. Restore never fails on a slot collision.
- **A trashed block is not addressable.** The id-addressed handlers (update,
  move, turn-into-page, delete, list) read `liveBlocks` and answer 404, the
  same answer an unknown id gets.
- **Readers read `liveBlocks`, never `_blocks`** (`live-blocks.ts`, exported
  beside `_blocks`): a drizzle subquery over `page_blocks WHERE deleted_at IS
  NULL`, so the predicate is never spelled by a reader and cannot be forgotten.
  A subquery and not a DB view because the rendered SQL still says
  `from "page_blocks"`, which the live-state read-set extractor and the
  change-feed match by name. `page-editor/no-unfiltered-blocks-read` flags any
  `.from(_blocks)` / `.join(_blocks)` outside the trash machinery (the
  allowlist in `lint/index.ts`); raw `sql\`… page_blocks …\`` reads are held
  to the same list by convention.
- **Trash never touches `page_block_docs`.** `doc-init` on a trashed or
  restored row returns the SURVIVING state and `doc-update` merges into it (the
  FK is satisfied while soft-deleted). A client that pre-seeds a restored row
  from `data.text` and then merges the surviving doc duplicates the paragraph —
  which is why the provider's pre-seed keys on *this client has never seen this
  id in server truth* (`RowTruth`), not on "row unconfirmed".
- **Derived state re-derives through the hooks.** `OnTrash` / `OnRestore` are
  handed rows (search deindex + reindex, backlink edge delete + rebuild, both
  filtering page rows in memory); content-block derived state follows the
  page's `blocksChanged`, whose readers are live-filtered. A reminder row is
  canceled when its token leaves the live text and REVIVED when a restore
  brings the same token back (`inline-date`'s reconciler). Attachment links of
  a trashed block are untouched (the reconcile writes live owners only), so the
  orphan sweep keeps the file until purge cascades the link.

## Text is doc-owned: a row write can never say `text`

> A block's text has exactly ONE owner: its per-block `Y.Doc`.
> `page_blocks.data.text` is a ~1 s-debounced **projection** of it — one writer
> (`projectText`), one reader (the doc-init seed).

That writer only accepts values READ FROM the doc (`DocSourcedRuns`, see the
projection under *Per-block CRDT text*), so the projection cannot persist a
value it did not read from the owner.

Row text is writable at block **creation** only: a brand-new id has no doc, so
its row is that doc's only seed (`use-collab-block-doc.ts`). `insertAfter`,
`BlockOp.insert.data`, `split.tailData`/`split.runs`/`merge.runs` and
`BlockHandle.empty()` therefore keep taking text — and so does `splice`, whose
`runs` is split's and whose forest rows are brand-new. An *edit* to an existing block
never does — and `RowData` (`core/row-data.ts`, `Record<string, unknown> &
{ text?: never }`) makes saying it a compile error, so `BlockEditorAPI.update` /
`convertTo` cannot express "convert this block AND set its text".

Exactly two functions in the row-write pipeline are allowed to name `text`, and
both exist to keep the projection out of everyone else's hands:

- **`preserveText`** (`block-editor-context.tsx`) — carries the row's existing
  projection across an `update`/`convertTo` untouched. A conversion keeps the
  block's id, hence its doc, hence its text, so the row must neither restate nor
  drop it. It carries the key UNCONDITIONALLY: whether it may SURVIVE on the
  resulting row is `conformRowText`'s question, below.
- **`rowDataOf(data)`** (`core/row-data.ts`) — a stored blob minus `text`, for a
  control that must restate the block's OTHER fields (`update` replaces the blob).
  `handle.emptyRowData()` is the same derivation over `empty()`, and is what every
  convert site seeds from, so none of them hand-strips.

### The rule is a BICONDITIONAL, and it lives at the funnel

> `data.text` is present on a row **iff** its type accepts text.

Both halves are a 400 at the write boundary: the key is an unrecognized key on a
void type's strict schema, and its ABSENCE is a missing required field on a
text-bearing one (`parse-block-data.ts` refuses to invent either).

It used to live in `preserveText` alone — i.e. at a CALL SITE — and both halves
were therefore broken for anyone who did not call through it:

- **text → void.** `projectText` is a third writer that names `text` and never
  called `preserveText`. Its flush fires from the text editor's UNMOUNT, which is
  exactly what a conversion into a void type causes, and it gated only on the row
  still existing — so every `/divider`, `/image`, `/place` and *Turn into → Page*
  posted a patch carrying `text` at a row the server already knew was void. The
  conversion itself is a different, successful write, so nothing looked broken;
  what it left was a durable HTTP failure that is **never retried and never
  resolves** (`use-optimistic-resource.ts` — failed ops are immune to
  confirmation and denial alike, and only NETWORK failures auto-retry), parking the
  page's save indicator on an error with a Retry that re-fails. **No user action
  clears it short of a reload.**
- **void → text.** `emptyRowData()` is the target's defaults minus `text`, and a
  void row has no prior projection to carry — so *Turn into → Text* off a divider
  wrote `{}` against a schema that requires `text`. That patch is the ONLY
  carrier of the conversion, so the conversion was rejected whole and lost on
  reload (the overlay renders a rejected write exactly like an accepted one).

`conformRowText`, applied in `commitRows`, is where the rule now lives. Three
things about it are load-bearing:

- **Rows this write AUTHORED, not the whole set.** `after` is every row — over the
  composite host, the union of several pages — and every writer returns `b`
  unchanged for rows it did not touch, so object identity against `before` is an
  exact test. Conforming the rest would sweep an unrelated row into this write's
  patch under this write's undo label, or (for `setExpanded`, `record: false`) as
  an unrecorded, unundoable data write.
- **`after` only, never `before`.** `patchesFromDiff`'s undo update is
  `fieldsOf(u.before, u.changes)`, so leaving `before` alone is what keeps undo of
  a text→void conversion restoring a text row WITH its text. Conforming `before`
  too, or conforming inside `diffBlocks`, reintroduces the bug in the other
  direction.
- **No registered handle ⇒ no opinion**, which is deliberately NOT the void
  branch. A type can be missing because it was renamed or removed while its rows
  live on, because the host mounted a subset of the block plugins, or because the
  row belongs to another page in the union. Stripping those rows' `text` deletes
  content. (`markdown-apply`'s `survivorData` enforces the same rule off the same
  `handle.text` lens and CAN collapse the two branches — because it never strips,
  only passes through. Do not copy its spelling here.)

Because the conform runs before the diff, the text→void projection now diffs to
nothing and `isEmptyPatch` drops it: the redundant write is not rejected, it is
never sent.

**This covers DIRECT row writes — not ops.** `dispatchOp` / `applyOverlay` /
`mergeBlock` diff raw `applyBlockOp` output through `recordEntry`, which
reaches the same strict endpoint without passing through `commitRows`. Their half of the same rule is enforced in the
reducer instead (see *A page's structural writes are one ordered stream*):
`applyMerge` refuses a text-less merge target, and `page.editor:split-targets-are-text-bearing`
fails the build on a declared split target that cannot hold text. Conforming op
output client-side would be WRONG — the server runs the same reducer and then
400s rather than conforming, so a silent client conform would predict a forest
the server refuses to produce, trading a loud 400 for a permanently unconfirmable
overlay op.

**Stripping text a conversion consumed is a content-doc edit, in this order.**
`convertStrippingText({ blockId, from, to, type, data })` is the ONE primitive
behind the slash menu, the gutter-`+` draft, and the markdown shortcuts:

1. delete `[from, to)` from the block's doc through `BlockFocusHandle.deleteRange`
   (`collab-text-surgery.ts`'s `deleteBlockTextRange` — `discrete: true`, so the
   binding's Yjs transaction lands synchronously);
2. `convertRow`, which writes the new `type` saying nothing about text — or, for
   a `wrapOnConvert` target, wraps instead of retyping.

**The wrap-vs-swap decision belongs to `convertRow`, the SHARED half.** It once
sat on `BlockEditorAPI.convertTo`, one level above, so `convertStrippingText`
bypassed it entirely and `/callout` from the slash menu retyped the origin into a
container — losing its text and 400ing on the callout's void schema — while
Turn-into wrapped correctly. A decision only one of two callers reaches is not
shared. Strip strictly BEFORE the wrap: the origin must lose its `/callout` query
from the content doc before it becomes the container's first child.

Both halves are load-bearing. A convert carrying the stripped text in its row
payload cannot strip anything — the row field is downstream of the doc — which
is how `/callout` used to leave the doc saying `/callout` while the row said
`text: []`, permanently, with which side the user saw depending on whether the
projection debounce had fired. And the strip must be `discrete` because the slash
commit runs INSIDE the caret menu's own `editor.update()`: a non-discrete nested
update commits on a microtask, racing the re-render the type write schedules.
No text type swaps its dispatch component any more (see the presentation-API
section below), so that race no longer costs an unmounted editor — but the
ordering stands on its own regardless of who renders the target: a row write is
downstream of the doc.
`e2e/convert-in-place-verify.ts` is the executable spec (type changed, marker
gone from DOM *and* `data.text`, the two in agreement, caret still in the block).

Backspace-reset / empty-Enter break-out strip **nothing** — a marker glyph was
never text — so they call plain `convertTo` and carry no payload but the target's
`emptyRowData()`.

## A text block's presentation is styling plus sibling regions

> Every text-bearing type dispatches the SAME component (`BlockTextRenderer`).
> A type change is a re-style, never a remount.

React unmounts when the element **TYPE at a position** changes. So the chain of
element types from the shared renderer's root down to `<LexicalComposer>` must be
constant, independent of `block.type`; props, classNames and styles may vary
freely. `components/text-block-layout.tsx` IS that fixed chain, and everything
else follows from it. (Same principle `BlockFrameProps` reaches on the container
axis: "a BACKDROP, not a wrapper".) Design:
[`research/2026-07-29-page-text-block-presentation-api.md`](../../../../research/2026-07-29-page-text-block-presentation-api.md).

A type therefore declares `chrome` (`BlockChrome`) and never a `component`:

- **styling** of elements that always exist — `padding` (outside the box),
  `surface`, `boxClassName` (paint only), `inset`;
- **sibling regions** around the editable line — `regions.{header,start,end,footer}`.
  A region gets **no `children`**, so it structurally cannot wrap the line. The
  set is **closed by geometry** (a leaf in a box has two block-axis and two
  inline-axis neighbours), so a new type never needs a new position; `header` and
  `end` have no consumer today, which is the price of actually closing it.

`Editor.Block`'s registration is a union discriminated off the handle's `text`
lens, so a text-bearing type naming a `component` is a **compile error**, and
`excludeFromReorder` is on the text-less arm ONLY — `ReorderItemMiddleware` flips
between `<SortableReorderItem>` and a Fragment on that field, i.e. an element-type
flip on an ancestor of the composer.

Four constraints that are not stylistic:

- **`chrome` is a STATIC object**, built at module eval in the contribution
  literal, so a region component's identity is a module constant *by
  construction*. A `chrome(data)` function would be a place to mint a fresh
  component per render (resetting that region on every keystroke) and to call a
  hook inside a per-type conditional (crashing on conversion). The one
  data-dependent knob, `boxClassName`, returns a **string**.
- **Regions are `ComponentType`, not `ReactNode`** — a prebuilt node cannot
  degrade when `editor` is absent, and a region with hooks needs its own scope.
- **Three totality rules** (stated in `text-block-layout.tsx`, read them before
  editing it): every skeleton element renders unconditionally and none may be a
  primitive that could collapse to a Fragment; each region occupies exactly ONE
  children-array slot (React pairs unkeyed siblings by `fiber.index`, so a length
  change mis-pairs the leaf cell and remounts Lexical); nothing keys or branches
  on `block.type`.
- **`padding` is static and `boxClassName` is paint-only.**
  `BlockHandle.gutterFirstLineCenter` is a static per-type declaration, so
  per-row vertical padding would seat the gutter rail on a phantom line; and
  `overflow-*` would silently change caret scroll semantics (Lexical's
  scroll-into-view and `internal/caret-geometry.ts` resolve against the nearest
  scrollable ancestor).

`BlockTextEditor` is the LEAF (the Lexical pipeline, no layout) and is
deliberately **not exported** from the web barrel — that removes the
roll-your-own-text-component affordance outright. `read-only-view` renders the
same `TextBlockLayout` with the same `chrome`, swapping only the leaf
(`RunsRenderer`) and passing **no `editor`**, which is how a region knows to
degrade. Spec: `e2e/convert-in-place-verify.ts`'s DOM-node-identity round trip —
the only assertion that catches a skeleton element which vanishes.

Still out of scope, by construction: content aligned to the editable's *wrapped
line boxes* (line numbers, per-line comment anchors, a diff rail) — a sibling
column cannot know line boxes without measuring rects; and a per-type wrapper of
any kind. Cross-cutting affordances (comments, presence) are `Editor.BlockRegion`
render slots at the same four positions, not a fifth knob.

## A block type declares its ARIA identity (`semantics`)

> A block type declares what its line **is** (`BlockHandle.semantics`),
> separately from what the line looks like (`textVariant`) and from what glyph
> precedes it (`marker`). The shared skeleton turns that declaration into ARIA
> attributes on the one element whose content is exactly the text.

The carrier is `TextBlockLayout`'s **leaf cell** — the one skeleton element whose
content is exactly the text. Everything that would pollute a name-from-content
role sits outside it: the marker gutter (`aria-hidden`), all four chrome regions,
the rail, and the row's `sr-only` "Selected. " marker.

**Attributes only** — the cell stays a `div` on every type and on both surfaces —
so none of the three totality rules above move, and a type change is still a
re-style. `semantics` rides the HANDLE, not `chrome` (styling plus sibling
regions; a role is neither), which is what makes one declaration serve the
editable and the read-only surface. On a type with no line it is a **compile
error**: `SemanticsFor` keys off the same `TextBearingSchema` brand as the text
lens, so a void type gets a named unsatisfiable object rather than an inert
field.

**The union is CLOSED, on two rules** (stated in `core/block-semantics.ts` — read
them before adding an arm):

- **The role's required ARIA context must be nothing.** The forest renders FLAT,
  so no element spans a run of blocks and none wraps a subtree. `listitem` needs
  an owning `list`; `blockquote` would have to CONTAIN the passage.
- **The role must not have presentational children.** The line hosts a
  `contenteditable`; `button` / `option` / `tab` / `img` would flatten the editing
  host into a label — the failure the old `role="listbox"` produced. `heading`
  takes its NAME from its contents and leaves them in the tree.

**`level` tracks the markdown prefix, never `textVariant`** (`# ` ⇔ 1). Deriving
a level from a font-size role is how a big paragraph starts announcing as a
heading.

Two carriers rejected. The **`<ContentEditable>`** drops Lexical's
`role="textbox"` (the signal that the line is editable) and the read-only surface
has none, so it would need a second mechanism; the `heading` > `textbox` nesting
we get instead is what `<h2 contenteditable>` produces natively. Real **`<h1>`
elements** are the per-type element type the fixed skeleton forbids outright.

The placeholder renders INSIDE the leaf cell, so it is `aria-hidden` — otherwise
an empty focused heading is *named* "Heading 1" by its own placeholder.

**Two things it cannot express**, and they are one gap: a role needing an owning
element, on a surface with no element to own it. A run of list siblings holds no
`listitem`s (no shared DOM element; introducing one would change a block's DOM
parent as it joins or leaves the run, remounting Lexical), and a `quote` /
`callout` container is no `blockquote` (its decoration is an inert backdrop
painted behind the rows, so it contains nothing). Neither is a missing arm: both
want `aria-owns` from a zero-height `role="list"` / `role="blockquote"` element
per run, grid-placed like `frameSpans`, owning the run by row id — a design on
the run-owning surface, with real a11y-tree re-parenting risk, so a follow-up
task.

Specs: `core/block-semantics.test.ts`, `web/__tests__/block-semantics.test.tsx`
(accessible name over a stand-in leaf) and `e2e/block-semantics-verify.ts` (real
browser: the three levels, a conversion gaining the role without losing the
caret, the hidden placeholder). Design:
[`research/2026-08-16-page-block-aria-semantics.md`](../../../../research/2026-08-16-page-block-aria-semantics.md).

## Per-block CRDT text (unconditional)

Per-block CRDT text is THE text pipeline
(`research/2026-07-07-page-per-block-crdt-plan-b.md`, Stages 0–5 complete — the
`crdtText` flag and the legacy `ValueSyncPlugin` + `useEditableField` autosave path
are deleted). Every `BlockTextEditor` binds to a **per-block `Y.Doc`** through
`@lexical/react`'s `CollaborationPlugin` (`components/collab-text-plugin.tsx`,
`id = block.id`, `shouldBootstrap={false}`, `editorState: null`), so remote/echoed
changes apply as a Yjs **merge**, never a serialized-string rebuild. Per Plan B,
**structure stays relational forever**: `page_blocks` rows remain the authoritative
tree and the structural op/patch pipeline is unchanged. Existing pages need no
migration — a block with no content doc lazy-seeds from `data.text` on first mount.

The transport seam is `internal/use-collab-block-doc.ts` — the ONLY place the
editor knows how content docs sync, so a future delta-WS transport swaps in behind
it and nothing else changes. It wires `internal/live-state-yjs-provider.ts`:
**in** = the `blockContentResource` keyed live subscription (`applyUpdate` with
provider origin — the echo guard), **out** = first-writer-wins `doc-init` seeding
(live doc hydrated ONLY from the server's authoritative response, closing the
duplicate-seed hazard) + debounced (~300 ms) `doc-update` posts of merged local
updates.

#### One owner per block, one session per binding

Lifetime lives in `internal/collab-session.ts` (read its module comment before
touching any of it):

> A block has ONE **owner** (`BlockDocOwner`) — canonical `Y.Doc`, transport
> provider, run tracker — and each mounted binding has ONE **session**
> (`CollabSession`) holding it. The session owns the replica's lifetime, the
> hold on the owner, and **the single retention policy**.

- **`session.end()` is the ONLY deferred teardown**, and it defers twice for two
  different reasons. One macrotask, because a remount-in-place keeps the very
  replica it holds — Lexical guards `providerFactory` AND `createBinding` behind
  refs (`@lexical/react` 0.44), so StrictMode's simulated remount never re-calls
  either, and `session.retain()` cancels the pending end. Then push-based onto
  the binding's own `disconnect()` while the replica is still CONNECTED
  (`BindingReplica.isConnected` / `setDisconnectListener`), so recovery racing an
  unmount cannot destroy a replica a live binding still relays through. Order
  inside one end is load-bearing: replica first (its disconnect's eager flush
  queues the last bytes), owner second (so `readyForTeardown` sees them).
- **Nothing releases by block id** — a session holds the owner *reference*, so a
  stale hold can never decrement the owner that replaced its own.
  `blockDocOwnerOf(id)` is the one id-keyed READ left, for the editor context's
  mutation chokepoints (which read `runsNow()` and run their surgery inside
  `untracked`) and the replay host selection. A read at record time is a
  *capture* of the doc's runs, never a reference an entry holds.
- **The owner's refcount is `private`, and the run tracker's suppression is a
  scope.** `untracked(edit)` is the only thing that can raise it, so "who raised
  it" has exactly one answer.

#### A session PROVES its hydration, and the proof gates the write path

> What this binding RENDERS equals what this session's replica HOLDS.

`SessionState` states it: `attaching → hydrating → hydrated | stalled`,
**monotonic** and **per session** (recovery is a new session), so a later
re-assert — the `markBlockRowConfirmed` doc-init, a second push, a StrictMode
re-`connect()` — cannot re-open a gate a proof already closed. Two arms, picked
at `start()` from the render-time `RowTruth` (below):

- **Locally authoritative** (`"unseen"`, and all of memory mode): the
  content is this client's own deterministic seed, applied *after* the binding
  attached, so no remote answer can be missing and there is nothing to prove —
  `attaching → hydrated` inside one synchronous `connect()`. **This is what
  keeps the instant-split path instant**: `maybeInit()` returns immediately
  while the row is unconfirmed, so waiting on the server here would cost a
  freshly-split block a full round trip. It also makes `stalled` structurally
  unreachable in memory mode.
- **Server authoritative** (`"present"` and `"removed"`): `hydrating` until the first `COLLABORATION_TAG`
  commit proves agreement — or until the transport announces `sync` with
  nothing renderable in the replica. That second exit is load-bearing: Yjs
  emits no event for an apply that integrates nothing, so **no commit is ever
  scheduled** and every genuinely-empty block would wait forever.

**The check cannot be synchronous.** `syncYjsChangesToLexical` commits without
`discrete` and `$commitPendingUpdates` is micro-tasked, while yjs emits
`doc.on('update')` at the tail of the same `applyUpdate` — inside our own
handlers the editor is exactly one microtask stale, so a same-turn comparison
calls every keystroke a blind binding. Hence the first-tagged-commit rule; the
tag also excludes Lexical's untagged initial commit and `$ensureEditorNotEmpty`'s
untagged follow-up. Do **not** force synchrony with `editor.read()` — from a Yjs
handler it re-enters `syncLexicalUpdateToYjs` inside that doc's own transaction
cleanup. The mount-time probe is `promoteOnly`: a merely-pending commit is
indistinguishable from a blind one, so it may confirm but never conclude.

Compare only `$xmlBasisContentLength()` against `xmlTextContentLength()` (the
fuzz-pinned pair — **agreement witnesses, not character counts**), measured on
the session's own **replica**: the canonical would import another binding's
concurrency into this verdict.

**It gates the WRITE path, never the editing host.** `hydrating` = the
projection does not persist and the transport does not flush.
`contentEditable={false}` would **deadlock the caret authority** (a
non-focusable root makes the landing's `root.focus()` a no-op, and `reconcile()`
only counts commits where the target is NOT rendered — it IS — so the flight
never ends and the keyboard is held). The replica is empty by construction at
attach, so typing into it is a legitimate concurrent edit that merges. The gate
is open in `attaching`, `hydrated` and `stalled` (a failure must not hold the
user's bytes hostage — it gets a Retry) and is released the moment `end()` is
called, so an unmount always flushes; a held queue is DEFERRED, never dropped.

**Placeholder:** `runsLength(runsOf(block.data.text))` — row non-empty + not
`hydrated` + **never rendered here** ⇒ skeleton at roughly that length
(`HydrationPlaceholder`; `primitives/loading`'s ~120 ms delay means a prompt doc
unmounts it before it paints); row empty ⇒ **nothing**, or most of a fresh page
becomes a loading screen; `stalled` ⇒ a Retry, right-aligned so it never covers
the live line. The "never rendered here" rung is `BlockDocOwner.everRendered` —
see *The hydration guard* below.

Until stage 5 (the diff-shaped `doc-init` pull) hydration is still the delivered
push, so the detector below stays the net for a push that never arrives.

#### A restored row binds to its surviving doc (`RowTruth`)

> The one thing that licenses an instant `data.text` pre-seed is: *this client
> has never seen this block id in server truth.*

The provider used to infer "no stored doc can exist" from "the row is not
confirmed" — true only while a delete hard-deleted the doc with its row. **Every
block delete is a trash** (the server soft-deletes; `page_block_docs` is never
touched, `doc-init` on a trashed or restored row returns the SURVIVING state and
`doc-update` merges into it), so an optimistically re-created row — undo of a
delete — is unconfirmed AND has a doc. A seed pre-applied for it lands as a
second paragraph the moment that doc merges. `internal/row-truth.ts` states
the fact the seed actually needs, DERIVED rather than inferred:

| `RowTruth` | meaning | seed | FK gate |
| --- | --- | --- | --- |
| `"present"` | in `serverIds` now | never | open |
| `"removed"` | in some EARLIER authoritative push, not now | only on a positive `null` answer | closed until confirmed |
| `"unseen"` | never seen in server truth by this editor | instantly at `connect()` | closed until confirmed |

- **Derived on the context** — `rowTruthOf(id)`, over `serverIds` and a
  monotonic `everServerIds` grown from every `store.serverData` push and never
  shrunk. `collab-text-plugin` passes it where `rowConfirmed` used to go;
  `useCollabBlockDoc` gates `markBlockRowConfirmed` on `"present"`;
  `CollabSession.start` sets `locallyAuthoritative = !serverSync || rowTruth ===
  "unseen"`.
- **Two provider facts, one immutable.** `blockRowConfirmed = rowTruth ===
  "present"` is the doc-init FK gate and only that (a one-way latch, lifted by
  the confirmation push). `mayHaveStoredDoc = rowTruth !== "unseen"` is the
  pre-seed discriminator, `readonly`: what this client had observed when the
  owner was minted, and the pre-seed it licenses happens once. `connect()`
  pre-seeds only `!mayHaveStoredDoc && serverState === undefined && clients ===
  0`; `ingestServerState` pre-applies the seed on a positive `null` answer for
  an unconfirmed row (`"removed"` whose doc did not survive, or `"unseen"`
  answered before connect), so a restored never-opened block renders after ONE
  round trip and the doc-init the confirmation then posts carries those exact
  bytes — its echo is a no-op.
- **Not a `restore` flag chosen per call site** (a second spelling, missing
  redo-of-split-undo and paste routes), and not strict-null everywhere (the
  instant split path would render an empty root for a round trip). The patch
  overlay op's `restoreIds` is the same fact read at the one dispatch
  chokepoint — `"removed"` creates — not a flag a caller sets.
- **The one residual**: `everServerIds` sees the pushes React RENDERED. An id
  created and deleted inside one batched render was never `"present"` here and
  reads `"unseen"` on re-creation — reachable only by a create→delete→undo
  faster than one commit.

Consequences on the write side: a flush racing a delete now SUCCEEDS into the
trashed doc (the better outcome — it is what undo restores); the provider's 409
path remains only for purge and the "doc row vanished" anomaly; `doc-init` 404s
only after purge.

### Projection + content-doc-aware split/merge

- **`doc → data.text` projection — a pure function of the OWNER.** It lives in
  the seam (`use-collab-block-doc.ts`), not in a consumer, and reads the
  canonical doc through `owner.runsNow()` — `projectableRunsOf(doc)` memoized
  on a content generation bumped in `doc.on("update")`, so a structural entry
  pinning a deleted row's text and the projection flush landing on the same
  generation share one headless read. `xmlTextToRuns` *is*
  `readYDoc(doc, e => serializeBlockRuns(e, extensions), …)` — the same walk and
  the same function object the live editor's own serialization uses, over a
  headless replica. Trigger: every canonical-doc update (push-based, local +
  server-applied), debounced ~1 s trailing. Changed runs go through `projectText`
  (`commitRow` with `record: false`, since Yjs owns text history) into the shared
  optimistic patch pipeline. It never echoes into any editor (`data.text` is read
  once, as the doc-init seed); skip-if-unchanged bounds churn; it flushes on
  teardown, never from a doc nothing ever wrote to. Rows trail the doc by ≤1 s,
  so search / backlinks / history stay fresh.

  **It may not read an editor — `projectText` takes `DocSourcedRuns`**
  (`internal/doc-sourced-runs.ts`): a brand keyed on a module-private `unique
  symbol`, produced only by `projectableRunsOf`, so persisting a value not read
  from the doc is a **tsc error** (same class as `PageForestTx` /
  `RowData`'s `{ text?: never }`). An editor is a VIEW that can silently fall
  behind — `@lexical/yjs` has no read-the-doc operation — and empty runs are
  indistinguishable from a legitimately empty block. Never swap `xmlTextToRuns`
  for a raw `toDelta()` walk: producing runs raw re-derives marks from
  `CollabTextNode` property sync, link nesting from embedded `XmlText`, and
  decorator tokens from node instances `ext.serializeNode(node)` needs. Counting
  gets away with a raw walk (`xmlTextContentLength`); producing runs does not.

  **The three other `serializeBlockRuns` callers stay editor-sourced.** Split /
  merge (`keyboard-plugin.tsx`) and `BlockFocusHandle.readRuns` want *what is on
  screen now, including uncommitted keystrokes* (`readRuns` is how `mergeNext`
  gets the next block's content without waiting the ~1 s projection). The
  discriminator: **a structural op reads the view; a persisted projection reads
  the owner.**

  **Flush-then-release is one cleanup in `useCollabDocHold`, in that order** —
  the final flush reads the canonical doc, so it must run while the hold still
  holds the entry. Do not split it across hooks and re-inherit the ordering from
  React's hook-declaration order.
- **Split (Enter)** keeps the row pipeline verbatim and additionally truncates the
  ORIGIN block's live editor from the caret (`BlockFocusHandle.truncateAt` →
  `internal/collab-text-surgery.ts`), driven THROUGH LEXICAL so the collab binding
  syncs the deletion into the content doc with marks/tokens intact. The projection
  is existence-gated against the RENDER-FRESH optimistic rows (`liveRowsRef`), not
  `rowsRef`: a deleted block's unmount flush fires before the effect that refreshes
  `rowsRef`, so an ungated flush would resurrect the just-deleted row.
- **Merge (Backspace-at-start)** appends the merging block's LIVE runs onto the
  target's bound editor (`BlockFocusHandle.appendRunsAtEnd`), then the structural
  merge deletes the block (a trash: its `page_block_docs` row survives, and undo
  binds the restored row back to it — see `RowTruth`). The append runs inside
  the target owner's `untracked` scope. If the target's editor is NOT mounted,
  the append goes through the stored-doc host (`spliceStoredBlockDoc`, relative
  to the runs the server holds) FIRST and the delete only fires after it lands —
  a failed append leaves both blocks intact. Either way the entry carries the
  target's runs before and after the append as data (see the undo section).
- **The doc-update pipeline is what reports "Saved".** The provider derives a
  `saveState` (`idle | syncing | error` + `lastFlushedAt`) from its own queue and
  publishes it via `onSaveState`/`getSaveState` (a memoized frozen snapshot, so a
  `useSyncExternalStore` consumer can never loop); `CollabTextPlugin` — mounted
  exactly once per block — feeds it to `useReportSync({ label: "text" })` and the
  surface aggregates (`error > syncing > saved > idle`), so the cloud says "Saved"
  only once every dirty block's bytes are server-acked. `syncing` starts at the
  KEYSTROKE edge, not when the 300 ms debounce expires. **Offline is `syncing`,
  never `error`** — a network-level rejection re-queues and retries push-based, so
  nothing is at risk; only a durable HTTP rejection (non-409 on `doc-update`,
  non-404 on `doc-init`) is an `error`, and it still throws loudly. `blockGone` is
  `idle` (bytes deliberately dropped; their content moved with the merge). The
  `data.text` projection is deliberately NOT reported: it is derived
  denormalization dispatched through the optimistic pipeline, which reports itself.
- **A `doc-update` 409 after sync means the doc row vanished** — a trashed
  block was PURGED mid-flush (a mere delete keeps the doc, so a flush racing a
  delete succeeds into the trashed doc). The provider never guesses: it
  re-arms its init path and lets a doc-init probe arbitrate. 404 (block genuinely
  gone) is a quiet terminal stop; success (block ALIVE, row unexpectedly gone)
  re-creates the row from the FULL local doc state — never the `data.text` seed,
  which would duplicate content the doc already holds — and resumes the flush loop,
  so a 409 can never silently stop a live block from saving.

### CRDT text on the ONE unified undo stack

Design: [`research/2026-09-09-page-data-based-text-undo-entries-v2.md`](../../../../research/2026-09-09-page-data-based-text-undo-entries-v2.md)
(supersedes Plan B's §Undo/redo).

- **Every entry is DATA.** A structural entry is a `BlockPatch` pair; a text
  entry is `{blockId, before, after}` runs (`BlockRunsEdit`); a gesture that is
  both (split, merge, an inline autoformat's strip) is ONE entry carrying a
  patch pair AND `runsEdits`. Nothing on the stack points into a doc's history.
  It used to: a text entry was a thunk popping the block's per-doc undo
  manager, guarded by "is this owner still live" — a **silent no-op** once the
  block's doc was destroyed, which is how a deleted to-do came back from Cmd+Z
  without its text. That manager and every thunk over it are deleted; a
  genuine replay failure now throws (`BlockTextReplayError`) and reaches
  Reports as a crash.
- **The run tracker records typing** (`internal/block-run-tracker.ts`, owned by
  `BlockDocOwner`). Every local transaction on the canonical doc opens or
  extends a run (`before = runsNow()` at open); a 500 ms idle window closes it
  and emits the runs edit, which `recordTextEdit` records with NO
  `coalesceKey` — the tracker already grouped the keystrokes, and app-level
  coalescing would merge two runs' data into one entry whose bracket no longer
  matches what one Cmd+Z reverts. Origins are classified by the **stated**
  three-origin rule, never learned: the transport provider (a server apply or
  a seed), `TEXT_REPLAY_ORIGIN` (an entry replaying), and the binding relayed
  verbatim (the user). `page-editor/no-adhoc-doc-write` keeps it three: only
  the replay host, the two providers and the relay may `applyUpdate` onto an
  owner's doc.
- **`untracked(edit)` is the suppression scope** for a gesture recording its
  own runs edit: it closes the open run first (so the entry sits above a fully
  recorded run, never inside it) and ignores every local transaction inside.
  The split's `truncateAt`, the merge's `appendRunsAtEnd` and
  `recordDocEdit`'s edit all run inside it — without it each would open a run
  and double-record on top of the structural entry (one Cmd+Z would restore
  the origin's full text while the split's tail still existed). Because the
  scope wraps the real Yjs transaction, the transaction must land
  synchronously inside it (`discrete: true`), and a caller inside a Lexical
  command handler or update listener must defer one microtask first (a nested
  `editor.update` is enqueued past the scope): the split keeps its own
  `queueMicrotask` around the truncation; `recordDocEdit` defers internally.
- **Replay has two hosts and one entry point** (`applyBlockRuns`,
  `internal/block-text-write-stored.ts`): a live owner whose doc holds content
  is spliced in process (host A, `spliceOpenBlockDoc`: a headless
  `$spliceRunsInto` delta applied under `TEXT_REPLAY_ORIGIN`, which the relay
  fans into every binding and the provider queues for flush); a live owner
  still waiting on its subscription waits for its `sync`; a block with no
  editor goes through the server (host B, `spliceStoredBlockDoc`: `doc-init`
  with the row's text as the proposal → headless splice → `doc-update`); a row
  just re-created optimistically waits, push-based, for the `serverIds`
  transition that confirms it — never `doc-init` a row the server may not
  have; memory mode with no owner writes the row. The stored write takes
  `runs` as a function of the authoritative current runs, so the unmounted
  merge appends onto what the server holds, never onto a lagged row.
- **Every removed row's `data.text` is pinned to its doc in the reverse patch.**
  `derivePatchEntry` pins, for each row in `before` and not in `after` that has
  a live AUTHORITATIVE owner (`BlockDocOwner.docAuthoritative` — synced, or a
  doc nothing can be stored behind; never a doc still waiting on its
  subscription, whose emptiness is a not-known-yet), the reverse `create`'s
  text to `owner.runsNow()`. A restored row's `data.text` is therefore
  doc-exact — what history snapshots, search and backlinks read, and the seed
  of a block whose doc did not survive (a purge).
- **The absolute-vs-CRDT trade, and the apply-and-report policy.** A data entry
  is absolute ("make this block read these runs"), where a CRDT undo manager
  was relative (undo *these items*). Under single-writer LIFO the two agree
  exactly; they part only when a SECOND writer edits the block between record
  and replay. The policy is: compare the block's current runs to what the
  entry expects (`after` on undo, `before` on redo), apply anyway, and report
  `stale-entry` (`undoConflictReportSink` → `reports/page-undo-conflict`).
  The user asked for their undo; clobbering the other writer's text is the
  residual, acceptable while it is measurably rare, and the report is what
  keeps it measurable. Upgrade path: a runs-level 3-way merge. The other seam
  is a remote apply landing INSIDE an open typing run: the run is aborted and
  `run-aborted` reported — one lost undo step at a genuinely concurrent
  moment (the hydration window included), never an entry that would carry the
  remote text as if the user had typed it.
- **Residuals, stated.** (1) Replay onto a block whose editor is mid-hydration
  waits on the transport; on a purged block host B's `doc-init` 404s and the
  replay throws. (2) Entries are still mount-scoped (they close over the page's
  optimistic store), so Cmd+Z does not reach back after navigating away — a
  follow-up.
- **The caret a replay lands on is DERIVED, never recorded.** A runs edit
  carries no caret: replay lands it at `changedSpanEnd(from, to)` (`core/rich-text.ts`)
  — the end of what the replay changed in the block, so undoing a deletion puts
  the caret after the restored text (`xxxx|yyyy` → `xxxxtext deleted|yyyy`) and
  redoing a typing run puts it after the re-typed text. It used to be read off
  the live selection when the run closed, which a deletion run never brackets
  (the caret is at the cut, and the previous run's end is wherever the user last
  typed) — undo landed at either end of the restored text depending on history.
- **Inverse pairs are handled by the overlay's ordering rule, not by absorption.**
  An undo patch followed by a redo patch before the undo's confirming push arrives
  leaves the undo op unable to ever confirm — every later snapshot shows X present,
  which confirms the redo and never the undo. The `optimistic-mutation` primitive
  resolves it by making the redo **wait**: an op may not leave the overlay while an
  older, still-pending, same-target op survives the pass (see that plugin's
  CLAUDE.md). The editor declares op identity via `sameOverlayTarget` (block-id-set
  intersection), so the inverse pair blocks as a pair while an unrelated block's
  confirmation never touches another block's op. Both replay meanwhile, so the
  render is correct throughout the wait, and the pair drains as soon as a
  watermark-carrying frame denies the undo.
- **An op leaves the overlay only for a causal reason — and that is now literally
  true.** It used not to be: same-target *cascade* dropped an older op on a newer
  op's evidence, which is a non-causal exit, and it cost a user a visibly
  disappearing block. What makes the claim true is that the only remaining exits
  are an op's own confirmation and Rule-B denial of that same op, both gated by the
  ordering rule so nothing leaves out of turn. The `op`/`patch` endpoints return
  their commit watermark (`currentTxId` read inside the write transaction), which is
  what gives denial its causal proof; there is no miss-limit eviction
  (`research/2026-07-11-global-never-revert-optimistic-edits.md`), so an op that
  fails to converge stays rendered and files a `stalled` divergence report instead
  of un-splitting the user's block.

### Inline markdown autoformat is ONE data entry

Typing `**x**` bolds `x` and drops the delimiters (also `__x__`, `*x*`/`_x_`,
`***x***`/`___x___`, `~~x~~`, `` `x` ``). The requirement is **one Cmd+Z reverts
only the formatting, restoring the literal `**x**`** — so it goes through
`recordDocEdit`, not a bare `editor.update`: the run tracker's 500 ms idle
window would fold the transform into the typing run and one Cmd+Z would eat
`**x**` whole. `recordDocEdit` closes the open run, runs the edit inside
`untracked`, and records the doc's runs before and after as one entry under
this plugin's label. Third consumer of that scope, not a new mechanism.

- **The edit is deferred one microtask, inside `recordDocEdit`.** An update
  listener runs with `editor._updating === true`, so an `editor.update()` issued
  there is *enqueued* and begins after the `untracked` scope has closed —
  formatting still applies, undo boundary silently doesn't exist (the tracker
  records it as typing). `applyInlineFormat` **throws** rather than returning
  `false` there, since that is indistinguishable from a benign drift-abort.
  (Same deferral as split's, which keeps its own.)
- **Tag-guarded (`historic`/`collaboration`/`paste`/`INLINE_FORMAT_TAG`), which is
  what makes undo reachable at all**: a replay re-inserts the delimiters on the
  canonical doc under `TEXT_REPLAY_ORIGIN` and `@lexical/yjs` renders it as a
  `collaboration` change, so an unguarded listener would re-format instantly
  and Cmd+Z look broken. The exactly-one-char-typed rule is a second defence,
  deliberately stricter than `@lexical/markdown`'s, which admits a *decreasing*
  offset and so auto-formats on **Backspace**.
- **Single-`TextNode` scope** (plus `isSimpleText()` — `splitText` on a segmented
  node or subclass slices characters that carry semantics). Makes the decorator
  tokens (`[[pageId]]`, `\(latex\)`) unreachable by any offset. Cost:
  `**see [[page]] here**` doesn't auto-bold; Cmd+B still does.
- **Marks set node-level, `hasFormat`-guarded** — byte-identically what
  `runs-lexical.ts` does, so `marksOf` reads back the same bits and the round-trip
  is correct by construction. The guard is why `` `code` `` inside a bold run adds
  code instead of clearing bold. Not `FORMAT_TEXT_COMMAND` (pulls in other
  listeners) nor `RangeSelection.formatText` (fresh selection has `format === 0`,
  making toggle-vs-set implicit over a partly-formatted range).

The delimiter table (`core/inline-markdown.ts`) is **closed core data, not a
slot** — block prefixes use `Editor.Block` because block types are an open set,
but `Mark` is a closed persisted `z.enum`. Its tests pin the marks as exactly
`MARK_ORDER` minus `underline` (no markdown syntax for it), so a sixth mark fails
the suite until someone decides its syntax. In `core/` because the clipboard
converter reads the same table.

### The same table, read left-to-right

`matchInlineFormat` answers "did the char I just typed close a span" — clamped to
the caret's line, closer at end-of-string. Clipboard export/paste asks about the
whole string, so the module carries a second pair over the SAME table
(`serializeInlineMarkdown` / `parseInlineMarkdown`), reached only through
`MdSerializeCtx.md` / `MdParseCtx.runs`. `ctx.plain` stays as the raw escape
hatch for a type whose syntax is not inline markdown at all (a fenced body, a
LaTeX expression). Read the module header for the escaping rule; three decisions
that look wrong until you know why:

- **`MarkdownContext.protectedSpans` is required, not optional.** Decorator
  tokens are plain substrings of `TextRun.text` and `\(latex\)` is full of `_`
  and `*` — an optional parameter is one a caller silently forgets. A masked span
  becomes its own UNMARKED run, byte-for-byte what `walkNode` gives a decorator.
  **Both runtimes supply it**: `blockTextProtectedSpans()` exists twice — over
  the web `registerBlockTextExtension` registry, and over the server's
  `Editor.InlineToken` contribution. They cannot drift: each token plugin
  contributes the same `core/` regex constant to both, only the Lexical
  (de)serialization halves being web-only.
- **Which families it holds is a SECOND declaration, not `pattern` again.** A
  token family states two independent things, and one regex can answer both,
  which is why they were one field for a while: `pattern` is the LOCATOR (find my
  token, so it can be built, serialized, re-materialized — every family has one),
  and `markdownSpan` (`"protect" | "transparent"`, `core/inline-markdown.ts`)
  says whether those bytes must be masked from this scan. Only `"protect"`
  families reach `blockTextProtectedSpans()`, on both runtimes.

  **Masking is not free, which is the whole reason it is a separate statement.**
  A masked span becomes its own run carrying NO MARKS, so protecting a span that
  did not need it silently DELETES the marks a person put on it. That is what a
  registered-token-gets-masking rule cost: `` `att-1787654245-y41m` `` pasted as
  markdown parsed with no `code` mark, and the id a person wrote as documentation
  came back as a live chip. Required rather than defaulted-off, because the two
  failure modes point opposite ways — an unprotected LaTeX token is corrupted,
  an over-protected bare id loses its marks — so there is no safe default and
  only the family that owns the bytes knows. `[[page:…]]`, `[[date:…]]` and
  `\(latex\)` protect; the four active-data bare-id chips do not.
- **The parser mirrors `matchInlineFormat`'s two whitespace rules**, so what the
  user can type and what pasted text parses as cannot diverge — which is why the
  serializer hoists boundary whitespace OUT of a marked group (`**a **` →
  `**a** `). Invisible when rendered; it is what makes `parse ∘ serialize` an
  identity rather than merely convergent.
- **`color` and `underline` get tags** (`<color value="…">`, `<u>`): color is a
  run attribute, not a mark, and underline is the one mark with no delimiter.
  `link` uses native `[text](url)`.

Two traps:

- **"Mark is OFF for text typed next" rests on a Lexical timing window, not an
  invariant** — the restored `selection.format` survives only via
  `markCollapsedSelectionFormat`, honored ~200 ms keyed on `(anchor.key, offset)`.
  `e2e/inline-format-verify.ts`'s ` tail` assertion is the only regression net; do
  not weaken it.
- **`markdown-shortcut-plugin.tsx` carries the same tag guard and advances
  `prevText` BEFORE its early return.** The guard stops our output (`~~- foo~~` →
  `- foo`) tripping a block conversion and closes a pre-existing hazard (a remote
  edit or Cmd+Z converting a block unprompted); skipping the baseline advance
  manufactures a phantom transition on the next keystroke.

Not guarded, deliberately: an in-flight `$$` math query can autoformat its LaTeX
(`$$a*b*`), `*` being intraword-legal. Coupling to `caret-trigger`'s arbiter was
rejected — candidacy is published even for a *dismissed* trigger, so one literal
`[[` in a line would silently disable autoformat for the rest of the node. The
right fix is the trigger owner consuming the keystroke.

### The hydration guard (a view may not overwrite what it disagrees with)

`@lexical/yjs` has NO read-the-doc operation: a binding ingests its doc solely
through post-attach `observeDeep` events, and the doc itself is hydrated solely
by the `page-block-doc` push. So both views of a block's text can silently fall
behind the one owner, and the symptom is identical — an empty block whose content
is safe on the server, restored by a reload. `collab-text-plugin`'s guard is what
makes that state observable and self-correcting:

- **`shown === 0 && doc > 0`** (armed by `CollabBlockDoc.subscribeDocUpdates`,
  read after a settle window) — the binding never hydrated. **`synced && doc === 0
  && row > 0 && never edited here`** (from the row, after its own window, since a
  starved doc receives no doc updates to trigger on) — the doc is behind the
  server. Both compare against **zero**, which is what keeps them basis-free: the
  doc-side and editor-side length walks agree with each other but with no
  character count (see `$xmlBasisContentLength`).
- **`isSynced` is what makes the second arm an observation rather than a bet.**
  Its claim is "the push never arrived", and only the transport can say that: while
  `!provider.isSynced` no authoritative answer has landed yet, so an empty doc
  proves nothing at all. Without the gate the arm was really timing the network —
  it waited 5 s from MOUNT while `sub:page-block-doc` reaches 907 s under load, so
  healthy cold opens tripped it constantly (572 reports, incl. 68 in 4 s). The
  window now opens on the sync EDGE and runs ~2 s, which is a grace for the apply
  and its commit, not a guess at latency.
- **Recovery has two verbs, and picking by defect is the whole point.**
  `CollabBlockDoc.rehydrate()` ends this block's content session and starts a new
  one; a new session IS a fresh EMPTY replica, which is the ONLY thing that fixes a
  binding that missed its post-attach `observeDeep` set — and is why it is
  destructive: the text genuinely leaves the DOM until the re-read lands. Its other
  job is bumping `attachGeneration` onto the `CollaborationPlugin` `key`, since
  Lexical builds its binding once per mount behind a ref. `CollabBlockDoc.refetch()`
  is the other half alone — `provider.rehydrateFromServer()`, an idempotent
  `doc-init` re-read merged into the live canonical doc, replica and session
  untouched, nothing on screen moving. So: `blind-binding` → `rehydrate()`,
  `starved-doc` → `refetch()`, the user-pressed `stalled` Retry → `rehydrate()`.
  A residual false positive then costs one request instead of blanking a line.
- **A skeleton never paints over text the user has already seen.**
  `BlockDocOwner.everRendered` is a monotonic latch set from
  `CollabSession.verifyRendered(shownLength > 0)` and never cleared — it states
  what the user WAS SHOWN, not what any session can currently prove. It lives on
  the OWNER because both things that would reset it are what it must survive:
  recovery mints a new session, and moving a block in or out of a container frame
  remounts its Lexical instance. It reaches the consumer folded into the existing
  hydration snapshot (one frozen `{state, everRendered}`, replaced only on a real
  transition — a second store would tear), and it gates the placeholder and
  nothing else: `hydrated` → nothing; `stalled` → Retry (above the latch: it is
  right-aligned, covers nothing, and a partially rendering binding still owes the
  user a way out); `everRendered` → nothing; empty row → nothing; else skeleton.
- **It is a DETECTOR, not a write gate.** It no longer stands in front of the
  projection: the projection reads the doc, so it cannot persist a blind
  binding's emptiness. What is left is a real, recoverable RENDER defect —
  reported (`collabHydrationReportSink` → `reports/collab-hydration`) because a
  silent self-heal is indistinguishable from a bug that never happened.

### Hardening

Validated against offline/reconnect, multi-tab, agent concurrency, and history
restore.

- **Doc-init is gated on the row being authoritative** (`RowTruth ===
  "present"` → `markBlockRowConfirmed`, one-way, lifted push-based by the same
  blocks push that commits the row). A freshly split block mounts its editor
  from the optimistic overlay *before* the structural POST creates its
  `_blocks` row, so an ungated doc-init FK-violates and the `initStarted` latch
  wedges the block editable-but-never-synced. Local edits in the gap buffer in
  the doc and flush right after the seed. Any `initDoc` failure re-arms
  `initStarted`; a doc-init 404 (block gone for good — purged; a trashed block
  is still addressable to doc-init) is a deliberate quiet TERMINAL stop,
  latching `blockGone` and dropping buffered bytes.
- **Seeds are deterministic, so pre-seeding is safe.** `runsToXmlText` takes a fixed
  Yjs `clientID` content-hashed from the runs JSON, so identical runs yield
  byte-identical encodings (and a mismatched seed can only duplicate, never corrupt
  by item-id collision). An `"unseen"` block therefore pre-applies its seed locally
  at `connect()` — hydrating synchronously instead of sitting EMPTY until
  confirm-push, where typing would merge badly with the later seed. The seed bytes
  are built ONCE per provider and reused for pre-apply and every doc-init retry,
  which must never post different bytes. The pre-seed DISCRIMINATOR is the
  provider's construction-time `mayHaveStoredDoc` (`RowTruth !== "unseen"`),
  never the row's confirmation and never an effect ordering: an existing block
  is `"present"` and a re-created one `"removed"` from their first render, so
  neither can pre-seed over a stored doc (DUPLICATED text on reopen / on
  restore). Keystrokes landing before the new block's editor is caret-ready are
  not dropped and not misrouted — the caret authority buffers them (see "The
  caret authority" above).
- **Split focus/caret under pre-seed.** The origin's deferred truncation carries
  `SKIP_DOM_SELECTION_TAG` (it is background surgery on the block the user is
  LEAVING; reconciling its cut-point selection would yank DOM focus back), and
  `focusHydratingAware`'s non-empty path passes `defaultSelection: "rootStart"`
  (a pre-seeded editor has no prior selection, and Lexical defaults to rootEnd).
- **Offline / reconnect: queue, never a retry timer.** Network-level seed/flush
  failures (fetch rejects, no HTTP status) are an expected local-first state — bytes
  re-queue at the head and retry on the live-state socket's reopen, the browser's
  `online` event (an idle WS may not surface a close promptly), the next server
  push, or the next local edit. Unexpected HTTP errors still throw loudly. Teardown
  is loss-safe: the session's deferred end finalizes the owner only when the provider is
  `readyForTeardown` (queue drained, or block server-confirmed gone), so an unmount
  during a transient outage RETAINS the owner and drains on the next reconnect edge.
  Known edge: closing the TAB while offline loses the last unflushed edits — the same
  class as an unflushed autosave.
- **The `data.text` projection dispatches an UPDATE, and an update never
  creates.** A row that is gone is skipped on BOTH the client overlay and the
  server writer, and `isPatchReflected` treats it as vacuously absorbed so the op
  confirms instead of sticking. Otherwise a debounced projection flush racing a
  history restore (or another tab's delete) resurrects the deleted row with
  pre-delete text. The patch's SHAPE is the guarantee — there is no flag to set,
  or forget.
- **History restore keeps block identity** (`restorePageContent`,
  `server/internal/page-content.ts`; design:
  [`research/2026-09-11-page-history-restore-preserves-block-identity.md`](../../../../research/2026-09-11-page-history-restore-preserves-block-identity.md)).
  It makes the page equal to the version by matching blocks BY ID, and hard-deletes
  nothing:
  - a block in both keeps its id and its content doc, and the doc is EDITED to the
    version's text;
  - a block deleted since comes back as itself, its surviving doc byte-exact;
  - a block created since is trashed, so restoring "Before restore" brings it back
    the same way.

  Three phases, in the same order every server-side content writer follows
  (structure, then the doc, then the `data.text` projection):
  1. **Revive** (before the lock): each `page-blocks` trash entry holding a
     version block trashed from this page is restored whole. A row such an entry
     holds that the version does not is trashed again in phase 2.
  2. **Structure** (under the lock): compute the target forest and write it with
     `writeForestTarget`, the op handler's own write. A version block whose id is
     free everywhere (purged) comes back under that id; one whose id is taken
     (live on another page, still in the trash, or turned into a sub-page) comes
     back as a fresh-id copy of its text. The write never changes a surviving
     row's `data.text` — that is phase 3's.
  3. **Text**: the caller's `writeTexts` (the history source passes
     `page/block-text-write`'s `writeBlockTexts`) splices each surviving block's
     doc to the version's runs, then projects `data.text`. It is a REQUIRED
     parameter because the editor cannot import the writer (a cycle), and a
     returned list of edits would be a step a caller could forget.

  **Sub-pages are never touched**: a restore never creates, revives, deletes or
  renames one. A live sub-page's row may only move — to its version position, or
  it stays put, or (its slot taken, or its parent trashed) it goes to the end of
  the page's top level. Its title is always its current one.

  Open editors need no special path. Surviving blocks keep their ids, so they stay
  mounted: structure arrives through the blocks push, and text arrives as a
  content-doc push the provider merges like any remote edit. Revived ids reach a
  tab that saw them as `RowTruth === "removed"`, which binds to the surviving doc
  (the undo-of-delete path). A typing run open on a rewritten block is aborted
  (`run-aborted`), and older undo entries on it replay as `stale-entry` — the
  documented concurrency policy. Known bound: a fresh-id copy is re-minted by
  every restore of that version (the previous copy is trashed), since nothing
  records which copy stands for which version block.
- **The offscreen-merge undo is a splice, not a positional cut.** Undoing a
  merge whose target had no editor brings the target's stored doc back to the
  recorded `before` runs through `$spliceRunsInto`, whose prefix alignment
  removes exactly the appended suffix and keeps every untouched unit's CRDT
  item. A concurrent append past the join is not an offset this write names —
  it shows up as a `stale-entry` conflict and is applied over (see the undo
  section's policy).

## Zoom (`rootId`)

`<BlockEditor pageId rootId>` opens ONE block as the whole editor: the root at
depth 0 and its descendants, editable, persisting to the page's own rows. Design:
[`research/2026-09-22-global-open-block-as-page.md`](../../../../research/2026-09-22-global-open-block-as-page.md).

> **The data stays whole; only the view is scoped.** The store, the reducer and
> the endpoints still work on the FULL page, so the client's predicted forest is
> the server's. `BlockEditorInner` renders `flattenVisible(subtreeOf(tree,
> rootId))`; `setRows` keeps every row, `setFlatOrder` gets the scoped list, so
> arrows, Cmd+A and the caret surfaces are scoped for free.

- **One backstop: `scopeAdmits`** (`internal/zoom-scope.ts`). A write is refused
  if the root's parent or rank changes, a row in the subtree ends up outside it, a
  new row lands outside it, or a row outside it changes in anything but its fold
  (`expanded` is exempt because the reducer itself opens the containers around a
  split). It runs at every structural chokepoint — `dispatchOp` (beside the
  empty-diff refusal), `applyOverlay`, the mounted merge (asked BEFORE the append,
  or the text would land with the source row still there) and `commitRows`.
  Undo/redo patches are exempt: they restore recorded states. `admits(op)` on the
  context asks the same question ahead of time, for affordances.
- **The gesture layer maps what it can onto in-scope ops**, so the backstop is
  rarely what the user meets: the top level is `scope.contentParentId` (the root)
  for `insert`, `insertFirst` and the anchorless paste; "below the root"
  (`insertAfter`, a paste anchored on it, the lower half of its row on a drop) is
  its FIRST child; the root drags nothing and a bulk drag drops it; a selection
  delete or duplicate naming it acts on its children; its ⋮⋮ menu hides Remove,
  Delete, wrapping conversions and `TurnInto`.
- **The keystroke resolver sees only the view** (`scopeNodes`: the root lifted to
  `parentId: null`) plus `IntentContext.scopeRootId`, which is what makes the
  root's children top level (no Shift+Tab out, no excess-indentation outdent),
  keeps the root's first line from unwrapping a zoomed container, and makes Enter
  on the root nest its tail.
- **A root not in the loaded rows is `gone`** — deleted, or moved to another page
  — and renders as such, never as an empty list (`subtreeOf` returns `null`).
- **Known gaps**, all refused by the backstop rather than escaping: a slash-menu
  wrap (`/callout`) on the root line strips its query and then does nothing, and
  a caret cut of the root copies without removing. `Editor.InsertAction` server
  ops (`/page`, `/agent-page`) on the root line bypass the backstop entirely —
  they are not structural ops on this page's lane.

## In-memory mode (`persist={false}`)

`<BlockEditor persist={false} initialContent={…} enabledBlockTypes={…}>` is a
self-contained, non-persisting editor: no `pageId`, no server rows, no network. It
powers throwaway surfaces (the public-site editor demo, drafts, previews, tests);
the whole document lives in React state and is discarded on unmount.

- **One persistence seam (`web/block-store.ts`).** `BlockEditorProvider` reads and
  writes ALL structure through a `BlockStore`; everything else in the provider
  (recording/undo, focus, `makeBlockAPI`, the CRDT projection) is storage-agnostic.
  `useMemoryBlockStore` is an authoritative synchronous `useState<Block[]>` reusing
  the SAME pure reducers/forest helpers as `useServerBlockStore`, so op/patch/insert
  semantics are byte-identical to the server. In memory `serverData === data`
  (every row is authoritative from the start, so the doc-init FK gate is inert).
- **A store is `pending`, then settled — and the provider only sees settled.**
  `BlockStore` is `PendingBlockStore | SettledBlockStore` (the store's own
  vocabulary, folded from `useOptimisticResource`'s `loading` / `error` arms:
  `{ pending: true, error: null }` or a failed first load with its `refetch`);
  only the settled arm has rows and `dispatch`. The server feed is the positional
  `useOptimisticResource(pageBlocks, { pageId }, …)` read, so there is no `[]`
  placeholder document an op could be folded onto. `BlockEditorProviderInner`
  takes a `SettledBlockStore` (tsc), and `BlockEditorProviderGate` is the one
  place that tells them apart: it renders the editor's loading state while the
  store is pending and mounts the provider once the base page's rows land, so
  every provider hook reads real rows and the context has no whole-document
  `pending`. In the composite (inline nested pages), an expanded child page
  whose own feed is still pending contributes NO rows — never an empty list —
  and its anchor row is named in `loadingBelow`, where `BlockRow` renders a
  loading region — or, when that feed's first load FAILED, in `failedBelow`
  (with the failure and its Retry), where `BlockRow` renders the error; an op routed to such a page throws (its rows are not on
  screen), and an undo patch for it takes the detached-persist path.
- **The store owns rank authority.** `move` takes positional intent
  (`zone`/`targetId`) plus the provider's `computeDrop` rank PREDICTION. The server
  store ships only the intent — no caller may hand the server a rank, because
  `page_blocks`' single `(parent_id, rank)` ordering space is projected disjointly
  by several live resources. The memory store has no such split (one synthetic
  page, holding the forest whole), so the prediction IS its authoritative key.
- **Local-only content docs.** The context flag `serverSync` is the ONE place the
  editor knows whether content docs sync. `CollabTextPlugin` branches on it: the
  in-memory path uses `useLocalCollabBlockDoc` with `LocalYjsProvider`, a purely
  local per-block `Y.Doc` seeded from `data.text` at `connect()` that NEVER networks
  — no subscription (which would also need a `NotificationsProvider` the demo does
  not mount), no doc-init/doc-update. The projection + run-tracker observers fire
  identically, so text edits still ride the unified undo stack. Both hooks return
  the same `CollabBlockDoc`, so `CollabBinding` reports to the sync-status cloud on
  either transport — the local provider is permanently `idle`, aggregating to
  silence.
- **Attachments gated.** `allowAttachments` is `serverSync`: image/video/file/…
  blocks need a server to store blobs, so memory mode excludes them from the
  palette (`enabledBlockTypes`) AND skips the file-drop / paste-file paths.
- **`Editor.TurnInto` gated.** A `TurnInto` contribution converts a block into
  something the pure `convertTo` cannot express — a server-backed transition
  (today: into a sub-page, re-partitioning `page_id` across a page boundary). The
  block-actions menu renders that whole zone only when `serverSync` — and
  `Editor.BlockMenuItem` (actions on a block's row, e.g. open-as-page, rendered in
  the menu's last section in both arms) the same way.

## The inline-token registry exists in BOTH runtimes

A token family (`[[page:…]]`, `[[date:…]]`, `\(latex\)`, an active-data chip)
declares its node ONCE in its own `core/` through `defineInlineTokenNode`, then
registers the browser's decorated twin with `registerBlockTextExtension` and
contributes the SAME core spec object to the server's `Editor.InlineToken`
alongside its pattern. One object, so the two runtimes cannot name a different
type string, fields or token format.

- **`registerBlockTextExtensionSource(() => [...])`** takes a LOOKUP for a
  contributor whose token set is itself a registry (active-data's chips, which
  fill in as the tiers load). A finished list handed over at module eval freezes
  whatever had loaded, and the seed and the doc-sourced projection then read two
  different sets — which round-trips a decorator into plain characters. A source
  must hand back STABLE objects while unchanged: the derived
  `InlineTokenExtension` is cached on object identity, and these walks run at
  caret frequency.
- **Server side**: `blockTextServerExtensions()` / `blockTextServerNodes()`, read
  at call time like `blockTextProtectedSpans()`. They are what let
  `markdown-apply` read and rewrite a block whose doc holds a decorator; a type
  with no server node is still refused there, loudly.
- Two contributions may share a node `type` only by naming the SAME spec object
  (that is how four active-data sub-plugins feed one node); two different
  objects for one type throw, naming both.

### A token family declares its READ-ONLY rendering too

`renderToken` sits on the SAME discriminated arm of `BlockTextExtension` as
`node` and `pattern`, so it is required exactly when there is a token to render
and unspellable when there is not. That is what makes `read-only-view` a total
function over the registry rather than a hand-maintained list of two types —
which is what it was, and why `[[date:…]]` painted as literal brackets on every
read surface for as long as inline dates existed.

`blockTextTokenExtension({ id, pattern, node, renderToken, Plugin })` is THE way
to build one. It exists to erase `renderToken` safely: a contributor writes the
typed `(fields: F) => ReactNode`, and what the registry stores takes the regex
MATCH and runs the family's own `fieldsOf` on it — the same erasure
`InlineTokenNodeRef.createFromMatch` performs, sound for the same reason (a
family is only ever handed a field record it produced itself). Without it every
contributor would read erased `string | null | undefined` fields and narrow them
back by hand.

- **Returning `null` means "not mine after all"** — a match `fieldsOf` rejects,
  or a union node whose chip is absent from this composition. The read surface
  paints the RAW TOKEN TEXT then, exactly as the Lexical decorator's own
  unclaimed arm does. It is never a way to render nothing, which would silently
  delete a token the document still holds.
- **`blockTextRenderableExtensions()`** is the read a surface with no Lexical
  takes: the registered extensions AS THEMSELVES, renderer included. `matchTokens`
  is generic in its extension type, so a match hands back the very registration
  that produced it — no join back by `id`, which is a string key nothing checks.
  Read at CALL time like every other registry read here.

**And no consumer may name a family**, which is the half a type cannot state:
`./singularity check page.editor:no-token-identity-outside-owner` fails any file
outside a family's own plugin that IMPORTS its `pattern:` constant or its
`defineInlineTokenNode` spec. It is the rung under the paragraph above — the
renderer that raced two hardcoded token patterns is exactly how `[[date:…]]`
shipped as literal brackets — and the governed set is discovered from the
registrations themselves, so a new family is covered with no edit. A family's
identity is co-owned by the plugin that declares the shape and the plugin that
registers it as a token, which is what leaves `ui-context/element-picker` free
to build a chip out of `ui-context`'s own `UI_CONTEXT_RE`.

### Pasting a token materializes it

`TokenPastePlugin` (from `primitives/text-editor/token-extension/node`) is mounted
in `block-text-editor.tsx` AFTER the contributed `ext.Plugin`s. Its place in the
`PASTE_COMMAND` chain is the whole of its behaviour, and the mount site is part of
that place — within one Lexical priority, listeners run in REGISTRATION order,
which here is JSX order:

| # | handler | priority | claims |
| --- | --- | --- | --- |
| 1 | `BlockPastePlugin` | NORMAL | a pasted FILE (an upload, never text) |
| 2 | `BlockForestPastePlugin` | NORMAL | forest MIME, or any multi-line text |
| 3 | `UrlPastePlugin` | LOW (an `ext.Plugin`, so registered first) | a bare URL at a collapsed caret |
| 4 | **`TokenPastePlugin`** | LOW | single-line text carrying a token |
| 5 | RichText default | EDITOR | everything else |

A URL pasted over a SELECTED range is `LinkPlugin`'s own LOW listener, which
wraps the range in a link; `UrlPastePlugin` declines every non-collapsed
selection, so the two never compete for one paste.

BELOW NORMAL because a file paste is an upload and a multi-line paste is
STRUCTURAL — a token inside either must not hijack them. Which also means this
only ever sees single-line text, so a plain inline insert is all it does. NOT
above `UrlPastePlugin`, because "a pasted URL becomes a link, with the Bookmark /
Embed / Mention menu beside it" is a shipped affordance; belt and braces, the two
gates are provably disjoint
(`inlineBoundary`'s `(?<!\/)` means an id inside a URL path matches nothing).
ABOVE EDITOR, so a token that would otherwise land as literal characters — and
stay literal forever, since nothing re-scans an existing doc — materializes.

**No CRDT surgery helper, deliberately.** `collab-text-surgery.ts` is for edits
driven from OUTSIDE a Lexical command; a `PASTE_COMMAND` listener already runs
inside `editor.update()`, so `selection.insertNodes` syncs through the
`@lexical/yjs` binding exactly like typing and is recorded by the block's
run tracker for free.

**Typing an id into an existing block leaves plain text**, and that is the
declared behaviour — there is no convert-as-you-type transform and no typeahead.
An id is only briefly complete while being typed (the classic autoformat trap),
here on top of a CRDT with hand-written caret-offset math. A raw id already in a
seeded doc self-heals the other way: any `edit_page` that rebuilds the block's
middle materializes it, and read-only surfaces chip it from `data.text` today.

## Markdown is a LOSSLESS PROJECTION of the forest

> Lenient on parse (foreign markdown pastes as it always did), CANONICAL on
> serialize: anything this codebase emits re-parses to the same forest — with one
> named exception, a paragraph whose text is only whitespace, in the blank-line
> bullets below.

`core/markdown.ts` stays the pure orchestrator that never names a block type. Its
void fallback is now the generic **`tag`** (`<name attrs>…</name>`, body parsed
recursively) instead of `() => ""` — which is why a type with no markdown
declaration at all (callout, image, video, audio, file, embed, bookmark) is
covered. Design:
[`research/2026-08-03-page-markdown-block-roundtrip.md`](../../../../research/2026-08-03-page-markdown-block-roundtrip.md);
`core/markdown.test.ts`'s fuzzed round-trip property test is the executable statement,
and it runs against the REAL block registry — the handles the app ships, read
through `core/testing/block-handles.ts`, rather than a hand-written copy of them. So a
new block type is added to the suite's GENERATOR rather than as a one-off case:
the generator's type set is asserted equal to the registry's, so a type that
gains no generator fails the suite instead of quietly going untested.

- **Only STRING fields become plain attributes**; everything else (numbers,
  booleans, `null`, objects) is JSON-encoded into one `data` attribute. An
  attribute value is a string both ways, so `width="640"` would read back as the
  string `"640"` — the "prettier" projection is lossy exactly where it claims not
  to be. Override `attrs` + `parseAttrs` TOGETHER for a nicer form.
- **`body` is declared, never derived** — and specifically not from
  `collapsible: "always"`, whose set includes `toggle`, which must keep emitting
  its children folded. `"children-when-expanded"` exists for `page` alone.
- **The walk takes an explicit "consumed my children" signal** from the
  serializer; it recurses unconditionally otherwise. Do not infer it.
- **A typing shortcut and markdown line syntax are two different declarations.**
  `markdownPrefixes` is markdown syntax and feeds serialize + parse + typing;
  `typingPrefixes` converts on TYPING only and this module never reads it.
  `quote` types with `| `, which in markdown is a **table row** — one field for
  both would make a pasted markdown table a wall of quotes. Same for `to-do`'s
  `[] `, `code-block`'s ```` ``` ````, `equation`'s `$$`, `divider`'s `---` and
  `todo`'s `TODO `, each of whose real markdown is declared elsewhere on the
  handle. `conversionPrefixesOf` (the union) has exactly one consumer, the
  shortcut plugin; `page.editor:block-prefixes-unique` keeps two types off one
  prefix.
- **`prompt` declares `body: "text"`** because it is the only text-bearing type
  with no MARKDOWN prefix; without it it serialized as a bare paragraph and came
  back as `text`. (`quote` had the same problem — `> ` belongs to `toggle` — but
  it is a void container now, so its tag carries `children`.)
- **A blank line IS an empty paragraph — in our own dialect only.** Every call
  site says which dialect its text is in through `MarkdownContext.blankLines`,
  required — so a call site that does not state its dialect is a tsc error, not
  one that inherits a default.
  What we emit and read back (`read_page`, `edit_page`, copy to the clipboard)
  declares `"empty-block"`; the three paste sites declare `"separator"` and still
  skip blank lines, which is correct CommonMark and the regression the whole
  field exists to prevent — a pasted README must not gain a spacer between every
  two paragraphs. On parse a blank line becomes the PREVIOUS SIBLING of the block
  that follows it, at that block's indent; two in a row give two empty blocks, no
  counting rule. A blank run with nothing after it — the start or end of a
  document, or of a tag body — is dropped. `markdown.ts` still names no block
  type: the empty block is minted through `defaultTextHandle`, so a composition
  shipping no default text type skips blank lines as before.
- **An empty block a blank line cannot place is PINNED as its tag.** A blank
  line carries no indentation of its own, so the parser places it by the block
  that FOLLOWS it and drops a run with nothing after it. Three positions are
  therefore unstatable that way, and they mirror those parser rules exactly: a
  node **with children** (which would land under them), the **first** of a
  sibling list and the **last** of one (a leading or trailing run, dropped at a
  document or tag-body edge). A fourth is pinned though a blank line could state
  it: one **beside a tag line** (the previous sibling's last line is a tag's, or
  the next sibling's first line is — a pinned block counts, so a run beside a
  card is pinned whole; `pinnedAt`). So a read never holds a blank line beside a
  tag, and in text an AGENT writes such a line means one thing, spacing:
  `dropBlankLinesBesideTags` drops it from `edit_page`'s `new_string` and
  `write_agent_note`'s content before they are parsed. `</human>\n\n<agent-inline>`
  used to mint an empty paragraph in the page's prose, outside the card, and the
  edit was refused. The rule is the agent's text's, never the parser's: a spacer
  already on the page stays one when a card lands beside it.
  `MarkdownContext.emptyBlocks` — required, beside
  `blankLines`, so a call site that does not state its dialect is a tsc error —
  says what happens there. `"pinned"` emits the handle's tag form instead of the
  blank line (`<text/>`, since `page/text`'s tag declares `attrs: () => ({})`);
  `"blank-line"` always emits the blank line and keeps the loss.
  - **It replaces only the LINE.** The walk still emits the node's children
    below it, exactly as for any other flat line. Routing through the tag branch
    would be a silent delete — a `body: "none"` tag self-closes and CONSUMES its
    children.
  - **It never invents a spelling.** A handle whose `tagFor()` is `null` keeps
    the blank line, so that loss stays, honestly.
  - **Who declares what.** `read_page` / `edit_page`
    (`markdown-apply/server/internal/markdown-context.ts`) and the planner's own
    re-serialization (`markdown-apply/core/plan.ts`) are `"pinned"` and MUST
    agree — the read and the diff are one dialect or alignment diffs two. The
    clipboard (`editor/web/internal/clipboard-write.ts`) is `"blank-line"`: a
    human pasting into another app must never see a tag, and the internal round
    trip travels as the structural `BLOCKS_MIME` payload anyway. The three web
    paste sites are parse-side and state `"blank-line"` because the record is
    one dialect.
  - **What is still lost, and cannot be spelled:** a paragraph whose text is
    only WHITESPACE (`" "`). It is a blank line to the tokenizer, so it
    re-parses as empty — and the tag means *empty*, so no dialect can say it.
  Design:
  [`research/2026-09-01-page-blank-line-empty-paragraph.md`](../../../../research/2026-09-01-page-blank-line-empty-paragraph.md)
  and
  [`research/2026-09-03-page-edit-judged-on-what-it-changed.md`](../../../../research/2026-09-03-page-edit-judged-on-what-it-changed.md).
- **A SOFT LINE BREAK has a spelling: the inline escape `\n`.** A `\n` inside a
  run is first-class content everywhere else — the type says so, Shift+Enter
  round-trips it, the Y doc keeps it as its own node, `read-only-view` paints a
  `<br>`. Markdown had no spelling for it, so `escapeText` emitted the newline
  verbatim, the walk fanned that ONE block into several document lines at its
  own indent, and the parser read them back as exactly that: `read_page` →
  `edit_page` unchanged planned CREATES, which nothing can subtract. Six pages
  on main were un-editable by an agent that way.
  Now `escapeText` writes the break as backslash + `n`, so the block stays on
  one line and nothing about the document's line, indent or blank-line rules has
  to know a break happened. Three silent losses fall out with it: a mark and a
  link across a break are no longer dropped (`matchDelimiter` and `matchLink`
  ABANDON a construct at a real newline — those guards are the reason the escape
  exists, and they stay), and a block whose text is only a break is no longer
  deleted by the empty-block pin.
  - **The dialect is `MarkdownContext.softBreaks`**, required beside
    `blankLines` and `emptyBlocks` and for the same reason. `"escaped"` is the
    agent-facing document (`read_page`/`edit_page` and the planner's own
    re-serialization, which MUST agree); `"newline"` is the clipboard, where a
    person pasting into another app has to see a real line break. Serialize
    only: the parse side decodes `\n` in both, because what we emit has to read
    back.
  - **One rule, no per-path exception.** The escape lives in `escapeText`, so
    every path that renders run text inherits it — including a `body: "text"`
    tag, which used to be the one place a real newline survived. A `prompt`
    body is one line in the escaped dialect and the multi-line form in the
    other; two spellings chosen by a condition an agent editing the body cannot
    see is worse than one spelling everywhere.
  - **`markdown.ts`'s `line.split("\n")` stays**, and `code-block` is its one
    reason: it declares an explicit `markdown.serialize` returning a genuinely
    multi-line fenced string. The escape belongs where run text is rendered and
    nowhere else — at the split the line is already opaque, so escaping there
    would collapse every fence onto one line.
  - **The escaped dialect ASSERTS its one line.** Two paths emit bytes verbatim
    and the escape cannot reach either: a `link` href holding a newline, and a
    `"protect"` span whose pattern matched across one (which `MarkdownSpan` now
    forbids). `serializeInlineMarkdown` throws naming the run instead of
    corrupting it silently.
  - **The accepted cost, stated:** decoding is unconditional, so a lone `\n` in
    FOREIGN pasted markdown now means a break — `C:\new`, and
    `` `printf "a\n"` `` inside a code span. Same class as the `\*`-in-a-code-span
    leniency this module already pins, and unavoidable given the escape.
  - **A break at the EDGE of a marked run is hoisted out of the mark**, which is
    pre-existing: `hoistBoundaryWhitespace` trims with `trimStart`/`trimEnd`, and
    those treat `\n` as whitespace. The round trip has always been
    `parse(serialize(x)) === canonical(x)`, and this is one more case of it — it
    lands as a text edit, which `subtractNoise` absorbs, never a create. An
    INTERIOR break inside a marked run round-trips exactly.
  Design:
  [`research/2026-09-10-page-soft-break-markdown-round-trip.md`](../../../../research/2026-09-10-page-soft-break-markdown-round-trip.md).
- **A paragraph whose words open with a block marker is escaped: `\3. x`.** The
  serializer asks who would claim the line it just wrote, through the SAME
  `claimersOf` / `claimOf` dispatch the parser uses (fence, then claimers by
  `precedence`, then default text) — one authority, so the two directions cannot
  disagree about what a line means. A line another type would claim gets ONE
  backslash at index 0, which every claimer's `^`-anchor or `trim()` defeats;
  the parse strips it and takes the rest as prose. Dialect-free and needing no
  fourth `MarkdownContext` field, since `\3. x` is correct CommonMark.
  - The probe reads the LEFT-STRIPPED line while the text keeps its spaces:
    leading whitespace is indent to the parser but content to a paragraph, so
    `"  3. x"` is escaped ahead of its own spaces. (`"  ---"` hides this —
    `divider` compares `trim()`.)
  - **Only the default-text type may be escaped.** Any other type whose own line
    is claimed by someone else THROWS — escaping it would make the block a
    paragraph on the way back, the very loss this closes.
  - **Two asserts, our dialect only** (the clipboard is deliberately lossy and
    must never throw during a Cmd+C): a `lines`-branch block emits ONE line
    unless it declares a `markdown.fence` or a `markdown.lineRun` (`equation`'s `"$$" + expression` fans
    a multi-line formula into sibling blocks otherwise), and a `lines` line never
    opens with `<` — which is what lets the claim authority skip the multi-line
    tag branch honestly.
  - **A hand-written claimer DECLARES the lines it claims.**
    `markdown.parseLine` is a `{claims, parse}` pair: a `markdownPrefixes` entry
    already states its own claim (`prefix + "x"` is a sample of it), but
    `/^\d+[.)]\s+(.*)$/` states it to nobody but the regex engine, and the
    escape rests on knowing who claims a line.
    `page.editor:markdown-claims-are-escapable` reads those declarations off the
    REAL handles and asserts both halves: every declared sample is claimed by the
    type that declared it — which is also the only thing pinning `to-do` above
    `bulleted-list` on `- [ ] x` — and one leading backslash leaves the same line
    claimed by nobody, the half `markdownPrefixes` cannot yield. The round-trip
    property runs on that same real registry, with its fuzz alphabet drawn from
    the same declarations; the hand-written copy it replaced picked its words so
    that no generated paragraph could open with a claimed line, which is exactly
    what let this bug through.
  Design:
  [`research/2026-09-20-page-markdown-line-claim-escape.md`](../../../../research/2026-09-20-page-markdown-line-claim-escape.md)
  and
  [`research/2026-09-20-page-markdown-claims-against-real-registry.md`](../../../../research/2026-09-20-page-markdown-claims-against-real-registry.md).
- **A block with no closing line is a LINE RUN** (`markdown.lineRun`), the
  third claim kind beside `parseLine` (one line) and `fence` (open…close). A GFM
  table is the shape: its rows simply stop. It declares `claims` (sample first
  lines, read by `markdown-claims-are-escapable` exactly like
  `parseLine.claims`), a LINE-LOCAL `matches(line)`, and
  `parse(lines, ctx) → { data, consumed } | null`.
  - **To the claim authority it is still a single-line claim**: `claimOf` asks
    `matches` of the first line (after fences, before the `parseLine`
    claimers), so the escape needs nothing new — a paragraph opening with `|`
    is written `\|…` and read back as prose, like any other claimed line.
  - **The walk collects the run**: the following lines at the SAME indent
    (compared explicitly, so a deeper table is a child, never a
    continuation), non-blank, each `matches`-ing on its own. `parse` takes
    the longest prefix it accepts and says how many lines that was; the walk
    offers the rest to itself again, so one run can hold several blocks back
    to back. `null` declines: the FIRST line is prose (re-serialized escaped —
    lenient parse, canonical serialize) and the walk moves on one line.
  - **Serialize** may emit several lines, and the one-line assert exempts a
    line-run type as it does a fence — but in our dialect every emitted line
    must `matches`, or the run would end there and the rest come back as
    siblings nobody wrote.
  - **Two ctx fields exist for it**: `protectedSpans` on both `MdParseCtx` and
    `MdSerializeCtx` (a table must not split a cell inside `\(a|b\)` or a
    `[[page:…]]` token), and `MdSerializeCtx.mdLine(runs)` — `md` forced into
    the escaped soft-break dialect, so a cell's break is `\n` even on the
    clipboard, where a real newline would end the row.
  - The core still names no block type; `page/table` is the declarer, and its
    CLAUDE.md states the table's own rules (adjacent tables, the cell escapes).

### The page tags

`<page id="…"/>` needs a row id, which `SerializedBlock` deliberately lacks — so
the serialize walk takes the wider `MarkdownNode` (`… id?: string`) and
`web/serialize-blocks.ts` stamps `id: block.id`. Both its consumers overwrite it
(`withMintedIds`): the id is provenance, never a destination identity.

- `page-link` owns `<page>` on parse; the sub-page handle's PRIMARY spelling is
  `serializeOnly` (two non-`serializeOnly` handles on one name is a loud error).
  **Markdown parse creates a sub-page only as an agent-authored page.** A human's
  sub-page means minting a `page_id` partition and restamping a subtree, which
  only the server's turn-into-page op does; `<page id="…"/>` always parses as a
  link. The id is what lets a markdown apply reconcile against the EXISTING row.
- **One row type, two spellings** (`BlockTag.spellings`): a `page` row whose
  `data.author === "agent"` is written `<agent-page id="…" title="…"/>`. The
  spelling's `data` preset (`{ author: "agent" }`) does both jobs — it picks the
  spelling on serialize and is merged over the attributes on parse — so the round
  trip is correct by construction, and asserted: a parse landing on a different
  spelling than the tag it came in under throws. `<agent-page>` IS claimed on
  parse, `identified` (the id becomes `ref`), and accepts only `title`; its tagless
  MINT form `<agent-page title="…">body</agent-page>` is a new page node carrying
  its body, which `markdown-apply` creates in a new partition.
  `markdownParseTagNames(h)` / `markdownTagNameOf(h, data)` are the shared
  resolution the uniqueness check, the planner and the agent policy read.
- **Every page pointer carries a title.** On `<agent-page>` it is the row's own
  `data.title`, emitted by the spelling's `attrs` and kept by its parse. On
  `<page>` it is an `annotated` attribute (read-only, discarded on parse) on BOTH
  handles that write the tag — the sub-page shell and `page-link` — because the
  link's title lives on another row. The `Editor.BlockAnnotation` providers are
  this plugin's server (a human sub-page's own title) and `page-link/server` (the
  target page's, one query; a deleted target emits none). `id` is emitted first
  whoever supplies it, so both kinds read `<page id="…" title="…"/>`.
- A **body on a parsed `<page>` is a loud rejection** — its content lives in its
  own partition. An EXISTING page's content is written by its own id; the one tag
  that may carry a page's body is `<agent-page>`'s mint form.
- **A page's KIND changes only through its own op, never a data edit.** A page
  is an ordinary page, an agent-authored page (`author: "agent"`) or an
  instructions page (`instructions: true`, plus `global`) — `PageKind`, read by
  `pageKindOf` and written by `withPageKind`, the one reading and writing of those
  keys. The kinds are exclusive, and `global` belongs to an instructions page:
  `BlockHandle.refine` (on `pageBlockAuthor`) states that where zod 3's `.refine`
  could not, and both `handle.parse` and the write boundary run it.
  `rewriteBlockData` (server) mints the `BlockDataRewrite` brand every UPDATE of
  `data` needs (`BlockColumnChanges.data`), and it refuses (409) a same-type
  rewrite whose markdown SPELLING (`markdownTagNameOf`) or `blockAuthorOf`
  differs — so the op writer, the patch writer and `PATCH /api/blocks/:id` all
  refuse changing the kind, by type construction. (`global` selects no spelling
  and stays a data edit, as on the inline `<instructions>` card.) The brand's one
  other mint is `rekindPageData`, the whole write of `setPageKind` (the page
  header's kind control): the stored data verbatim with only the kind keys
  replaced, so a change carries no other edit either. A page's kind is first
  chosen at birth — turn-into-page's `kind` (`agent-page` is the `/agent-page`
  insert, `instructions` the `/instructions page` insert) or an `<agent-page>`
  markdown mint; creates stay free. An `<instructions-page>` is `pointerOnly`: a
  markdown parse of it without its id is refused, so no agent mints one.
  **History restore keeps the CURRENT kind**: `restorePageContent` carries the
  stored row's kind onto the version's page data, so a version taken before a
  change restores content, title, icon and cover but never the page's kind (as it
  never moves the page).
- **`renamePage` is the server-side title write** (an agent's rename via
  `edit_page`'s `# Title` line): `{...stored, title}` through `rewriteBlockData`,
  under the page row's lock. Its `requireAuthor` precondition is judged under
  that same lock, because the human can flip the page between the tool's
  decision and the write.
- **A page's icon is an emoji** (`PageDataSchema.icon: EmojiSchema.nullable()`,
  `ui/icons/emoji` — exactly one RGI emoji grapheme; a Material Symbols name is
  no longer storable). `<PageIcon>` draws it as an `EmojiGlyph` in the same
  `size-*` box as the fallback `description` symbol. Pages contribute nothing to
  the saved-icon sprites any more (the callout's own icon stays a symbol).
  **`setPageIcon(pageId, icon, { onlyIfUnset? }, executor?)`** is the
  server-side icon write, built on `rewritePageRow` like `renamePage`:
  `{...stored, icon}` under the page forest's lock, announced after commit;
  `onlyIfUnset` writes only when the page has no icon under that lock, so an
  automatic writer never overwrites a user's pick. Like every forest write it
  takes a handle that can OPEN a transaction, never a caller's transaction. The
  header still writes its icon through its own `PATCH`.
- **A patch's creates stay in its world.** `applyPageBlockPatch` accepts a create
  whose `pageId` is the locked page or a page the same patch creates, and refuses
  any other with a 400. Every page a write inserts is announced with its own
  `blocksChanged` (`ForestWriteResult.createdPageIds`), mirroring deleted pages —
  which also covers a sub-page created by paste or duplicate.
- A parsed forest is uniformly `expanded: true` — a self-closing tag cannot
  distinguish "collapsed" from "childless", and blocks are born expanded.

### Reserved attributes: a tag may carry facts the block does not own

A TODO card's linked task and that task's status live in another table keyed by
the block id, so no projection of `data` can produce them — and putting them in
`data` would make the block's row a drifting second copy of somebody else's
record. `BlockTag.annotated: readonly string[]` is `identified` generalized: a
declared SET of names, reserved in BOTH directions, whose values the CALLER
supplies (`MarkdownNode.annotations` → `MdSerializeCtx.annotations`) rather than
the walk.

- **Serialize** emits reserved names first (`id`, then annotations in
  declaration order, then the type's own attrs). An absent value OMITS its
  attribute — the clipboard has neither ids nor annotations and must still
  serialize.
- **Parse** deletes every reserved name before `dataOf`, exactly where `id`
  comes off. Otherwise the round trip is not closed: a void `z.object({})`
  strips the unknown key (the attribute is decorative), a `.strict()` one 400s
  on a document this side emitted.
- **The values are DISCARDED on parse ⇒ these attributes are READ-ONLY.** The
  parser is pure: it cannot tell an agent's edit from the value it emitted a
  minute ago, nor write the owning table. `status="done"` typed into a document
  is ignored, and the tool handing out the document says so.

Loud, never silent: a name colliding with a schema field the DERIVED projection
would emit / `data` / an `identified` `id` throws at resolution (a tag declaring
its own `attrs` may reserve a field name — `page` reserves `title` — and is held
to it by the serialize-time check below); a type's own `attrs` emitting a reserved
name throws at serialize; and a node carrying an annotation its tag never
declared (or any annotation at all, for a type serializing as LINES) throws —
emitting it would make it a `data` key on the way back in, dropping it would
lose a fact its supplier believes the document carries.

**Who fills them in is a server registry**: `Editor.BlockAnnotation` takes the
rows a read is about to walk and answers block id → attribute record;
`resolveBlockAnnotations(rows)` merges every provider and throws when two claim
one `(block, attribute)` pair. `markdown-apply`'s read resolves it *after*
`redact`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Block-based document editor component and slot system. Block-based document editor — tables, routes, and live state.
- Web:
  - Slots:
    - `Editor.Block`
    - `Editor.BlockFrame`
    - `Editor.TurnInto`
    - `Editor.BlockMenuItem`
    - `Editor.FormatAction`
    - `Editor.InsertAction`
  - Slot contributors: 51 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `Editor.Block` ×30
    - `Editor.BlockFrame` ×8
    - `Editor.FormatAction` ×7
    - `Editor.InsertAction` ×3
    - `Editor.TurnInto` ×2
    - `Editor.BlockMenuItem` ← `page.open-as-page`
  - Contributes: `IdKinds.Kind` "block"
  - Uses: 83 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/text-editor/caret-trigger` ×5
    - `primitives/css/spacing` ×4
    - `primitives/css/ui-kit` ×4
    - `primitives/dom/dom-selection` ×4
    - `primitives/live-state` ×4
    - `primitives/slot-render` ×4
    - `primitives/undo-redo` ×4
    - `network/live` ×3
    - `primitives/css/control-panel` ×3
    - `primitives/css/coords` ×3
    - `primitives/multi-select` ×3
    - `primitives/optimistic-mutation` ×3
    - `primitives/text-editor/caret-motion` ×3
    - `reorder` ×3
    - `infra/endpoints` ×2
    - `primitives/latest-ref` ×2
    - `primitives/persistent-draft` ×2
    - `ids.IdKinds`
    - `primitives/announce.announce`
    - `primitives/copy-to-clipboard.useCopyToClipboard`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/inline.Inline`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/row.Row`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/dom/auto-scroll.useEdgeAutoScroll`
    - `primitives/dom/scroll-reveal.useRevealOnActive`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/networking.subscribeWsStatus`
    - `primitives/scope/dom-scope.defineDomScope`
    - `primitives/scope/scoped-store.defineScopedStore`
    - `primitives/select-scope.ContentScope`
    - `primitives/sync-status.useReportSync`
    - `primitives/text-editor/decorator-nav.DecoratorNavPlugin`
    - `primitives/text-editor/token-extension/node.TokenPastePlugin`
    - `shell/toast.showToast`
    - `ui/icons/emoji.EmojiGlyph`
    - `ui/icons.Icon`
  - Exports (types):
    - `BlockAnchorProps`
    - `BlockChrome`
    - `BlockContribution`
    - `BlockDecoration`
    - `BlockDecorationSeat`
    - `BlockEditorAPI`
    - `BlockEditorHandle`
    - `BlockFootProps`
    - `BlockFrameMeta`
    - `BlockFrameProps`
    - `BlockPasteHandler`
    - `BlockPlainText`
    - `BlockPlainTextControl`
    - `BlockPlainTextOptions`
    - `BlockPlainTextProps`
    - `BlockRegion`
    - `BlockRegionProps`
    - `BlockRegions`
    - `BlockRendererProps`
    - `BlockSection`
    - `BlockTextAreaProps`
    - `BlockTextExtension`
    - `BlockTextPluginProps`
    - `BlockTextSelection`
    - `BlockTextTokenExtension`
    - `BlockView`
    - `CaretFlightAbortReason`
    - `CaretFlightAbortReport`
    - `CaretSurface`
    - `CaretSurfaceRef`
    - `CollabHydrationReason`
    - `CollabHydrationReport`
    - `EditorScope`
    - `FormatToolbarValue`
    - `FrameCandidate`
    - `FrameGeometry`
    - `FramePad`
    - `InsertAction`
    - `InsertActionContext`
    - `InsertActionRun`
    - `InsertEntry`
    - `InsertSection`
    - `MarkButtonProps`
    - `PageIconProps`
    - `PageOption`
    - `PageOptionsResult`
    - `SelectionControl`
    - `TextBlockLayoutProps`
    - `UndoConflictReason`
    - `UndoConflictReport`
    - `VoidCaret`
    - `VoidCaretOptions`
  - Exports (values):
    - `BLOCK_INDENT`
    - `BLOCK_INSET`
    - `blockContentScope`
    - `BlockEditor`
    - `blockRowIn`
    - `blockRowsIn`
    - `BlockTextArea`
    - `blockTextRenderableExtensions`
    - `BlockTextRenderer`
    - `blockTextTokenExtension`
    - `BlockTypeList`
    - `caretFlightReportSink`
    - `collabHydrationReportSink`
    - `colorCssValue`
    - `Editor`
    - `filterInsertEntries`
    - `flattenSections`
    - `FRAME_PAD_X`
    - `FRAME_PAD_Y`
    - `frameBoxLeft`
    - `FrameHoverProvider`
    - `getBlockTextExtensions`
    - `isValidLinkUrl`
    - `MarkButton`
    - `MARKER_GUTTER`
    - `normalizeLinkUrl`
    - `OPEN_LINK_POPOVER_COMMAND`
    - `PageContentColumn`
    - `PageIcon`
    - `PageOptionsList`
    - `readTransferText`
    - `registerBlockPasteHandler`
    - `registerBlockTextExtension`
    - `registerBlockTextExtensionSource`
    - `TextBlockLayout`
    - `undoConflictReportSink`
    - `useBlockActivate`
    - `useBlockDecorations`
    - `useBlockEditor`
    - `useBlockFeet`
    - `useBlockPlainText`
    - `useCaretEscape`
    - `useEditorScope`
    - `useFormatToolbar`
    - `useFrameGeometry`
    - `useFrameHovered`
    - `useGroupedInsertableBlocks`
    - `useInsertableBlocks`
    - `useIsFramedBlock`
    - `usePageMarkdownContext`
    - `usePageOptions`
    - `useSelectionControl`
    - `useSetFrameHover`
    - `useVoidCaret`
- Server:
  - Contributes:
    - `ids.kind` "block"
    - `resource.declare` "page-blocks"
    - `resource.declare` "page.block-locations:rows"
    - `resource.declare` "pages.tree"
    - `resource.declare` "pages.tree:rows"
    - `derived-table` "page_content_edited_at"
    - `page.block-data` "page"
    - `page.block-annotation`
  - Uses:
    - `database.currentTxId`
    - `database.db`
    - `database.DbExecutor`
    - `database/derived-tables.DerivedTable`
    - `database/derived-updated-at.deriveUpdatedAt`
    - `database/sql-column.parsedJson`
    - `ids.IdKinds`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/events.defineTriggerEvent`
    - `infra/trash._trashEntries`
    - `infra/trash.defineTrashSource`
    - `infra/trash.recordTrashEntry`
    - `network/live.serveCollection`
    - `network/live.serveValue`
    - `primitives/rank.nextRankUnder`
    - `primitives/rank.rankAdjacentTo`
    - `primitives/rank.rankAfterSibling`
  - DB schema:
    - `plugins/page/plugins/editor/server/internal/rollup-table.ts`
    - `plugins/page/plugins/editor/server/internal/tables-events.ts`
    - `plugins/page/plugins/editor/server/internal/tables.ts`
  - Exports (types):
    - `AfterCommit`
    - `Block`
    - `BlockCopyHook`
    - `BlockCreateHook`
    - `BlockDeleteHook`
    - `BlockRestoreHook`
    - `BlocksChangedPayload`
    - `BlockTextWriter`
    - `BlockTrashHook`
    - `CopiedBlock`
    - `DeletedBlockRow`
    - `DocRankDrift`
    - `PageContentSnapshot`
    - `PageData`
    - `PageForestTx`
    - `StoredBlock`
  - Exports (values):
    - `_blocks`
    - `applyPageBlockPatch`
    - `BlockLifecycle`
    - `blocksChanged`
    - `BlockSchema`
    - `blockTextProtectedSpans`
    - `blockTextServerExtensions`
    - `blockTextServerNodes`
    - `deleteBlocksSubtree`
    - `docRankDriftSink`
    - `Editor`
    - `liveBlocks`
    - `PAGE_BLOCK_TYPE`
    - `pageData`
    - `PageDataSchema`
    - `readPageEditedAt`
    - `renamePage`
    - `resolveBlockAnnotations`
    - `restorePageContent`
    - `serializePageContent`
    - `setPageIcon`
  - Register:
    - `defineTriggerEvent('page.blocksChanged')`
    - `defineTrashSource('pages')`
    - `defineTrashSource('page-blocks')`
  - Resources:
    - `page-blocks` (push, unbounded: one page's content forest — the reducer, the optimistic overlay and document order need every block of the page, never a window)
    - `page.block-locations:rows` (keyed, point)
    - `pages.tree` (keyed)
    - `pages.tree:rows` (keyed, point)
  - Routes:
    - `GET /api/pages`
    - `GET /api/pages/:pageId/blocks`
    - `GET /api/blocks/:id/page`
    - `POST /api/blocks`
    - `PATCH /api/blocks/:id`
    - `DELETE /api/blocks/:id`
    - `POST /api/blocks/:id/move`
    - `POST /api/blocks/move-many`
    - `POST /api/blocks/:id/turn-into-page`
    - `POST /api/blocks/:id/page-kind`
    - `POST /api/pages/:pageId/blocks/op`
    - `POST /api/pages/:pageId/blocks/patch`
- Core:
  - Uses: 26 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `fields` ×3
    - `network/live` ×3
    - `primitives/collab-doc` ×3
    - `primitives/text-editor/token-extension` ×3
    - `primitives/tree` ×3
    - `page/block-entity` ×2
    - `primitives/rank` ×2
    - `fields/date/config.dateField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `infra/endpoints.defineEndpoint`
    - `infra/trash.TrashOutcomeSchema`
    - `primitives/text-editor/token-extension/node.defineInlineTokenNode`
    - `ui/icons/emoji.EmojiSchema`
  - Exports (types):
    - `Block`
    - `BlockAudience`
    - `BlockAuthor`
    - `BlockData`
    - `BlockDiff`
    - `BlockFieldChanges`
    - `BlockHandle`
    - `BlockLocation`
    - `BlockMarkdown`
    - `BlockNode`
    - `BlockOp`
    - `BlockOpContext`
    - `BlockPage`
    - `BlockPatch`
    - `BlockSemantics`
    - `BlockSemanticsAttrs`
    - `BlockTag`
    - `BlockTagBody`
    - `BlockTagSpelling`
    - `BlockTextVariant`
    - `BlockUpdate`
    - `ColorToken`
    - `CreateBlockBody`
    - `ForestGranularity`
    - `IdentifiedBlock`
    - `InlineFormatContext`
    - `InlineFormatMatch`
    - `InlineSyntax`
    - `IsAnchor`
    - `Mark`
    - `MarkdownContext`
    - `MarkdownNode`
    - `MarkdownSpan`
    - `MdParseCtx`
    - `MdSerializeCtx`
    - `MoveBlockBody`
    - `PageCover`
    - `PageData`
    - `PageKind`
    - `PageRow`
    - `PageSource`
    - `PagesTreeRow`
    - `RichText`
    - `RowData`
    - `SerializedBlock`
    - `SetPageKindBody`
    - `SoftBreaks`
    - `SpanLines`
    - `SpanPoint`
    - `SpanSelection`
    - `SpliceCaret`
    - `TagLine`
    - `TextBearingSchema`
    - `TextData`
    - `TextRun`
    - `TurnIntoPageBody`
    - `UpdateBlockBody`
  - Exports (values):
    - `applyBlockOp`
    - `applyBlockOpEndpoint`
    - `blockAuthorOf`
    - `BlockFieldChangesSchema`
    - `blockIdKind`
    - `blockLocations`
    - `BlockLocationSchema`
    - `blockOpContextOf`
    - `BlockOpSchema`
    - `BlockPageSchema`
    - `BlockPatchSchema`
    - `BlockSchema`
    - `blockSelectionRoots`
    - `canIndent`
    - `canOutdent`
    - `changedFields`
    - `changedSpanEnd`
    - `childrenOf`
    - `coalesce`
    - `collapsedAnchorAbove`
    - `COLOR_TOKENS`
    - `colorCssValue`
    - `conversionPrefixesOf`
    - `createBlock`
    - `CreateBlockBodySchema`
    - `dataEqual`
    - `defaultTextHandle`
    - `defineBlock`
    - `deleteBlock`
    - `diffBlocks`
    - `dropBlankLinesBesideTags`
    - `formatTagLine`
    - `getBlockPage`
    - `hasTextKey`
    - `IdentifiedBlockSchema`
    - `inDocumentOrder`
    - `INLINE_SYNTAXES`
    - `isEmptyPatch`
    - `joinAroundSpan`
    - `listBlocks`
    - `listPages`
    - `MARK_ORDER`
    - `markdownLineClaim`
    - `markdownParseTagNames`
    - `markdownTagIsIdentified`
    - `markdownTagNameOf`
    - `markdownTagNamesAuthoredBy`
    - `marksOfTextNode`
    - `matchInlineFormat`
    - `mergeRuns`
    - `moveBlock`
    - `MoveBlockBodySchema`
    - `moveBlocks`
    - `namesField`
    - `newBlockId`
    - `nextVisibleLine`
    - `normalizeSpan`
    - `opNamedIds`
    - `PAGE_BLOCK_TYPE`
    - `PAGE_BLOCKS_TRASH_SOURCE`
    - `pageBlockAuthor`
    - `pageBlockHandle`
    - `pageBlockMarkdown`
    - `pageBlocks`
    - `PageCoverSchema`
    - `pageData`
    - `PageDataSchema`
    - `pageKindOf`
    - `PageKindSchema`
    - `PageRowSchema`
    - `PAGES_TRASH_SOURCE`
    - `pageSourcesOf`
    - `pagesTree`
    - `parseInlineMarkdown`
    - `parseMarkdownToForest`
    - `parseTagLine`
    - `pasteAnchorId`
    - `patchBlocks`
    - `patchesFromDiff`
    - `plainOf`
    - `planForestInsert`
    - `planSplice`
    - `prevVisibleLine`
    - `rankWindow`
    - `RichTextSchema`
    - `rowDataOf`
    - `runsEqual`
    - `runsLength`
    - `runsOf`
    - `runsOfNode`
    - `runsToLexical`
    - `runsToXmlText`
    - `samePageKind`
    - `semanticsAttrs`
    - `serializeBlockRuns`
    - `SerializedBlockSchema`
    - `serializeForestToMarkdown`
    - `serializeInlineMarkdown`
    - `setPageKind`
    - `SetPageKindBodySchema`
    - `sortMarks`
    - `splitRuns`
    - `stepTextOffset`
    - `textBlockSchema`
    - `textDataSchema`
    - `textOf`
    - `TextRunSchema`
    - `tokenOf`
    - `toNodes`
    - `turnIntoPage`
    - `TurnIntoPageBodySchema`
    - `updateBlock`
    - `UpdateBlockBodySchema`
    - `visibleChildrenOf`
    - `visibleChildRule`
    - `withContainersSelected`
    - `withMintedIds`
    - `withPageKind`
    - `withPasteIds`
    - `withRuns`
    - `writtenIds`
    - `xmlTextContentLength`
    - `xmlTextToRuns`
- Cross-plugin:
  - Uses tokens: 29 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×11
    - `ui/tokens/type-scale` ×9
    - `ui/tokens/density` ×5
    - `ui/tokens/shape` ×2
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shadow --shadow`
  - Imported by: 75 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `page` ×57
    - `apps` ×8
    - `reports` ×4
    - `active-data` ×3
    - `primitives` ×2
    - `debug/slow-ops`
  - Extended by:
    - `apps/pages/auto-icon` (table `editor_ext_auto_icon`)
    - `apps/pages/agent-origin` (table `editor_ext_origin`)
    - `apps/pages/starred` (table `editor_ext_starred`)
    - `page/tags` (table `editor_ext_tags`)
    - `page/annotations/todo/task-link` (table `editor_ext_todo_task`)
  - Endpoint callers: `editor-collab`
- Exemptions:
  - Exempts itself from:
    - `page-editor/no-adhoc-forest-write` — `server/internal/forest-writer.ts` (sanctioned)
    - `page-editor/no-adhoc-doc-write` — `web/__tests__`, `web/internal/block-text-write.ts`, `web/internal/live-state-yjs-provider.ts`, `web/internal/local-yjs-provider.ts` (sanctioned)
    - `page-editor/no-unfiltered-blocks-read` — `server/internal/forest-writer.ts`, `server/internal/handle-patch-blocks.ts`, `server/internal/live-blocks.ts`, `server/internal/page-forest.ts`, `server/internal/trash-blocks.ts` (sanctioned)
    - `page-editor/no-unfiltered-blocks-read` — `server/internal/page-clipboard.ts` (sanctioned)
    - `page-editor/no-adhoc-structural-write` — `web/block-store.ts`, `web/composite-block-store.tsx` (sanctioned)
    - `page-editor/no-unhistoried-block-field` — `web/components/block-text-area.tsx` (sanctioned)
    - `sortable-list/no-raw-dnd-kit` — `web` (sanctioned)
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `ids:pk-declared` — `server/internal/tables-events.ts` (debt)
  - Exempted by: `page/editor` (0 debt)
- Test helpers:
  - Web: `@plugins/page/plugins/editor/web/testing`
    - `blockTextRunsOptions` — The registry-bound options for the runs ↔ `Y.XmlText` bridge (`core/runs-yjs.ts`): every registered token extension, plus the decorator node classes those extensions materialize.
  - Server: `@plugins/page/plugins/editor/server/testing`
    - `untrashBlocks` — Restore an entry's flagged rows AND consume the entry — the trash sources' `restore` callback and the un-trash prelude of the patch handler.
  - Core: `@plugins/page/plugins/editor/core/testing`
    - `collectBlockHandles` — Every registered block handle, with the plugin id that declared it.
    - `loadBlockHandles` — The real block handles, or a THROW.
    - `resolveBlockSlots` — The two web block SLOT OBJECTS, resolved once per call from the declaration pass that named them, so every loop that reads a block contribution compares by IDENTITY instead of against an id string.
    - `WEB_BLOCK_FRAME_SLOT`
    - `WEB_BLOCK_SLOT`

<!-- AUTOGENERATED:END -->
