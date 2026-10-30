# editor

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

## The sidebar's ordering space is `docRank`, not `rank`

`page_blocks.rank` is comparable **only within one `(parent_id, rank)` space**. The
Pages sidebar's sibling group (pages sharing a `pageId`) spans several, so two rows
can hold the same rank (`Rank.between("a1","a1")` throws in `computeDrop`). The
server therefore stores the order: `page_blocks.doc_rank` (nullable `rank_text`,
NULL on content rows), emitted as `PageRow.docRank` by `pagesTree` and
`GET /api/pages`. Display order, array order and `computeFlatReorder`'s
neighbourhood are one order (the sidebar sorts by `docRank` via `inDocOrder`).

> **Invariant I-DR.** For each group P (live page rows sharing `page_id`; NULL is
> the root group), ordering by `doc_rank` equals document order — `docOrderRows` +
> `compareDocOrder`: rank-ordered DFS pre-order, stopping at nested pages.

Maintained at the one structural-write chokepoint:

- **Marks in the lowest-level mutators** (`insertBlocks`, `updateBlockFields` when
  it names `parentId`/`rank`/`type`/`pageId`/`deletedAt` — old `page_id` too,
  `trashBlockRoots`, `untrashBlockRoots`, `deleteBlockRoots`,
  `recomputePageIdSubtree`) record dirty groups in a module-private
  `WeakMap<PageForestTx, Set<scope>>` (`doc-order-dirty.ts`). Composite writers
  inherit them.
- **Reconcile in `withPageForest`** after `fn(ctx)` (`doc-rank.ts`): scoped
  `docOrderRows`, sorted in JS by `compareDocOrder`, `planDocRanks`
  (`core/doc-rank.ts`, pure: keep the longest increasing run, re-mint the rest with
  `Rank.nBetween`; throws if its output is not strictly ascending — there is no
  unique index), `writeDocRanks` writes only changes in one statement. Data-only
  writes mark nothing (0 queries).
- **Boot reconcile** (`onReadyBlocking`, `doc-rank-boot.ts`): plans globally, re-mints
  under the groups' locks. First keys = silent backfill; anything else is **drift**,
  announced on `docRankDriftSink` (→ `reports/page-doc-rank-drift`). A sink, never a
  `reports` import: this barrel is loaded by drizzle-kit, and `reports/server`
  throws at module eval outside a backend (`schema-files-loadable`).
- **`docRank` is `touchedBy: false`** — a re-mint never moves `updated_at`.

Rules:

- **`docRank` is never written into `rank`, nor in a request body.** `NewBlockRow` /
  `BlockColumnChanges` cannot name it; `writeDocRanks` is its only writer. Moves send
  positional intent; the server mints the rank. `pageBlocks` rows carry no `docRank`.
- **Membership is never a function of the traversal**: `docOrderRows` drives off the
  plain live-page select, LEFT-joining the path CTE (unresolvable path → `path: null`,
  sorted last by raw `rank`).
- **Don't move the sort into SQL**: a recursive CTE can drop `COLLATE "C"` and sort by
  locale (`'a' < 'B'`, while `Rank.compare` says `'B' < 'a'`). `ORDER BY doc_rank` on
  the column itself is fine.
- **A live page with no `doc_rank` is a loud loader error**, never minted at read time.

`doc-rank.test.ts` is the writer oracle (random op sequences asserting I-DR after
every step).

## The page tree is a routed collection (`pagesTree`, key `pages.tree`)

Every live page:

```ts
liveCollection("pages.tree", {
  from: pagesEntityRef,
  fields: { editedAt },
  carry,
  all: { orderBy: createdAt, unbounded },
});
```

- **Served** by `serveCollection` over the `page_blocks` table
  (`server/internal/page-rows.ts`, the one spelling server and tests compile),
  `where type='page' AND deleted_at IS NULL`.
- **`docRank` is bound to `doc_rank` by name** (a leaked NULL fails the row
  schema's `RankSchema` loudly).
- **Readers**: `useLive(pagesTree)` for the set (sidebar, `usePageOptions`,
  breadcrumb, Recent pages…), `useLiveRow(pagesTree, id)` for one page.
- **Declared by fields over the entity**: the table is
  `defineEntity(pagesEntityRef, { docRank, deletedAt, trashEntryId }, meta)`
  (`server/internal/tables.ts`), so ref and table cannot disagree.
  Block-extension fields fold in under `$columns` (starred, `origin`, `tags`).
  Row pinned to `PageRow` (`_PinPagesTreeRow`).
- **Order is `createdAt` because it never moves** — a `doc_rank` re-mint is an in-place
  refill, never an `orderOf`. Renderers sort by `docRank`.
- **`editedAt`** = `pageEditedAtSql` (`page-rows.ts`, one spelling):
  - `greatest(page row updated_at, page_content_edited_at rollup)`;
  - the rollup (`server/internal/rollup-spec.ts`) is a `derived-tables` rollup of
    `max(updated_at)` per page;
  - `readPageEditedAt` (markdown-apply's `<page-meta>`) reads the same expression,
    so header, sidebar, Recent pages and `<page-meta>` agree.
- Costs are pinned per step by `server/internal/pages-tree-oracle.test.ts`.

**`blockLocations`** (`page.block-locations`, lookup-only `:rows`): any live block's
`{ id, type, pageId }`; `useBlockTarget` resolves a bare block id through it.
`GET /api/blocks/:id/page` is the same answer over HTTP, for the page-link e2e only.

## A page's forest is a scoped collection (`pageBlocks`, key `page-blocks.v2`)

```ts
liveCollection("page-blocks.v2", {
  from: pagesEntityRef,
  baseExposures: false,
  carry,
  all: { by: ["pageId"], orderBy: [rank, createdAt], unbounded },
});
```

One tuple per page (sub-page rows included), served over `page_blocks` with
`deleted_at IS NULL` (`pageBlocksServeOptions`, `server/internal/resources.ts`).
Row pinned to `Block` (`_PinPageBlocksRow`).

- **Readers**:
  - the block store:
    `useOptimisticResource(pageBlocks, { where: { pageId } }, …)`;
  - `enqueueDetachedWrite` on the same lane;
  - `useLive` in history preview and page outline;
  - `useLiveRow(pageBlocks, blockId)` for the block crumb;
  - `listBlocks` reads `pageBlocksServed.all.load({ pageId })`, so the HTTP twin
    cannot drift.
- Costs pinned by `server/internal/page-blocks-oracle.test.ts` (typing projection =
  one one-row refill of its page; never a full load).
- Renaming the key is how old tabs get a clean `unknown-key` skew verdict rather than
  a frozen page (`web/__tests__/page-blocks-old-tab.test.ts`).

## The page column (one owner for the content-left edge)

`web/internal/page-column.ts` is the single declaration site for the column's
horizontal geometry.

> - `C` is the ORIGIN the surface computes and the rail seats against.
> - Block **content** insets from `C` by `BLOCK_INSET`.
> - Block **decorations paint that same content box** (code background, place card,
>   callout tint, quote rule, annotation wash — `frameBoxLeft`), so a box edge and
>   the prose's first letter share one x.
> - Padding inside a box is a separate declaration: `FRAME_PAD_X` / `FRAME_PAD_Y`.
> - Exceptions (marks that are not boxes): the block-selection highlight and the diff
>   rail start at `C`, so a selected card's band surrounds its tint.
> - Host chrome alongside blocks (title, icon, section list) sits at `C + BLOCK_INSET`.

- The editable surface reserves the hover rail (`BLOCK_GUTTER`, 64px) left of `C`,
  inside each row's padding. `read-only-view` has no rail (`C` = its left edge).
- A row seats its controls against the content edge of its **outermost enclosing
  container frame** (its own when unframed), so a container anchor's decoration in
  the `BLOCK_INDENT` column is not covered (and made unclickable) by a child's rail.
  `block-editor.tsx` derives the seat from `frameSpans` (`internal/rail-seat.ts`);
  `BlockRow` computes no geometry.
- **The span rule is not the ownership rule** (stated in `rail-seat.ts`): `left` is a
  SPAN rule (every row in a frame seats at its edge); `owner` is a BORROW-CHAIN rule
  (only the borrowed first line transfers ownership).
- **Hosts never compute the edge.** `BLOCK_GUTTER` is not exported. Editable page →
  `<PageContentColumn>`; read-only → `<Inset x={BLOCK_INSET}>` with `<ReadOnlyBlocks>`
  at `C`; a new block type → `<Inset x={BLOCK_INSET} y="…">` (vertical padding is
  per block).
- Never splice a ramp step into a class name (`` `pl-${BLOCK_INSET}` ``) — Tailwind
  only emits literal tokens. Use `<Inset>` or `insetClass()`.
- A container frame is handed `C` as `inset` and adds `BLOCK_INSET` once (in
  `ContainerBackdrop`). `blockContentLeft(depth)` is the one derivation of `C` in row
  coordinates; nobody re-derives `BLOCK_GUTTER + depth * BLOCK_INDENT`.

## Container frames (the one exception to the flat list)

The forest renders as a **flat list of sibling rows** (`flattenTree`): every block
stays under one React parent so indent/outdent/move only reorder keyed elements and a
block's Lexical instance (and focus) survives. So a renderer can only paint its own
row.

`Editor.BlockFrame` makes a type a **container**: `internal/block-frames.ts` groups its
visible subtree (always contiguous in a DFS flatten) and hands it to the contribution
as `children`, which paints a box around it. A collapsed container still gets a frame
around its own row; containers nest.

- **Only contributing types are grouped** — membership derives from the slot's own
  matches (`useIsFramedBlock`).
- **Membership is per BLOCK**: `applies(block)` (pure over `type`, `data`, fold) for a
  type that is a container only in some states (an agent/instructions sub-page is a
  card only while expanded inline). Geometry maps stay keyed by type.
- **A frame is a BACKDROP**: appearance only, no flow, cannot shift rows or reserve
  space. Decorations inset to the `inset` prop; padding is reserved by the rows (*A
  card's padding is declared, not left over*).
- **Geometry reads the DOM** (`[data-block-id]` + `getBoundingClientRect()`), never
  React tree position.
- Cost: moving a block into/out of a frame changes its DOM parent and remounts Lexical
  (only on that transition; the content owner outlives it — *One owner per block*).
  Spec: `e2e/indent-caret-verify.ts`.

**Foot** (`BlockFrameMeta.foot`): chrome at the bottom of the box, inside its padding
(the TODO card's run chips).

- **Not a decoration**: a decoration floats and reserves no space (hence exactly one
  per container); a foot has its own height and the box makes room for it.
- **Where it renders**: a sibling AFTER `<BlockRow>` in the grid cell of the frame's
  LAST covered row (no new grid geometry), in the row layer (so it may carry
  controls), with **no `data-block-id`** (row finders and drop targets must not see
  it).
- **Accepted consequences**:
  - selecting the card (or its last child) highlights the foot too;
  - a card whose last child is another card has the inner box paint over the outer
    foot.

`read-only-view` dispatches the same slot with `inset: 0`.

### A card's padding is declared, not left over

> The gap between a container's box and the text inside is ONE declared quantity per
> axis (`FRAME_PAD_X` / `FRAME_PAD_Y`, `page-column.ts`), read by every side.

- **X is `BLOCK_INDENT`** (the children are one indent deeper, so the left gap is
  already decided); **Y is a smaller token** (a vertical gap is measured to a line box
  that already carries padding and leading).
- **Two counts, one apart**: a ROW reserves one pad per enclosing frame (`padFrames`);
  a FRAME pulls its box in by one pad per frame enclosing IT, itself excluded. Never
  reuse one count for both (that gave 0px right padding).
- **Rows buy vertical space**: the first covered row reserves `padding-top`, the last
  `padding-bottom` (`padFramesOpening` / `padFramesClosing`); the frame's
  `topInset`/`bottomInset` are only its nesting share.
- **A frame closes on a SLOT, not a row.** At flat row `i` the slots are the row, then
  the feet of footed frames ending at `i`, innermost first.
  > A frame `P` ending at row `i` reserves its bottom pad on the LAST slot CONTAINED in
  > `P` — the outermost `F_m` with `F_m.start ≥ P.start`, or the row when none.

  Not symmetric: a card inside a footed card keeps its pad on the row. Resolved once
  (`internal/frame-foot.ts`) for the three readers: the row's `padding-bottom`
  (`resolveRailSeats`), `resolveFramePadInsets` (compares SLOT KEYS, not `end`
  indices), and the foot's own padding.
- **Never on the anchor row** (zero height): the pad lands on the first row rendering
  a line; a childless container pads its own row.
- **`--gutter-first-line-center` adds the pad above it** (`firstLinePad`).
- **`BlockFrameMeta.pad` is required**: `"box"` for filled shapes (callout, annotation
  cards), `"rule"` for a bar (quote) — `"rule"` frames are filtered before counting.
- `read-only-view` reserves the same pad on its real wrapper divs.

### A container that owns no text: the anchor row

`BlockHandle.anchor`: the container's content *is* its children (callout: void
`{icon, color}`, first line an ordinary `text` child — so converting that child cannot
touch the container, and Enter inside is a plain sibling split).

- **Zero height only while it has visible children**; childless, the row falls back to
  one empty line (else an invisible, undeletable 0px ghost).
- **It borrows its first child's line** for the gutter seat and the fold (*A container
  folds to its borrowed line*). No `collapsible` declaration; `expanded` is live.
- **The decoration lives in the row layer, never the frame** (frames are
  `pointer-events-none` and emitted before rows). Declared on the `Editor.BlockFrame`
  contribution, mounted by the surface in one of TWO seats:
  - **`anchor`** — glyph in the `BLOCK_INDENT` column at the box's left edge, on the
    first child's first-line centre (callout icon);
  - **`cornerAnchor`** — the card's NAME at the top-right corner, shown on hover
    (annotation family).

  The union is closed at two; a foot is not a third seat
  (`page-editor:anchor-has-decoration` pins exactly one). The corner seat's hover
  signal is `internal/frame-hover.ts` (a scoped store rows write on pointer-enter and
  only decorations read — a frame is a grid sibling, so `group-hover` cannot work);
  `read-only-view` uses a plain `group/frame`.
- **An anchor row renders no rail *of its own*** — the rail on its borrowed line
  already resolves (`RailSeat.owner`) to the outermost borrowing container: `+`, drag
  and menu act on the container. A second rail would also register a duplicate
  dnd-kit `drag:<id>`.

### The rail's menu dispatches by owner

`BlockActionsMenu` is the one rail popover, two arms chosen by the core fact
`BlockHandle.anchor` (never by whether a plugin contributed sections):

- ordinary owner → *Turn into* (+ `Editor.TurnInto` with no `from` or `from` its
  type) + *Delete*;
- **container** owner → its `BlockFrameMeta.menu` sections, *Turn into* with ONLY
  `TurnInto` contributions declared `from` its type, *Collapse/Expand*
  (`RailSeat.owner.childCount > 1`), *Remove `<label>`* (`unwrapBlock`, wording from
  `handle.label`), *Delete*. No block-type list: a void container has nowhere to put
  children on a type conversion.

`menu` is a second field on the `Editor.BlockFrame` registration
(`useBlockFrameMenus`, twin of `useBlockDecorations`). `anchor` is core because the
reducer needs it (`BlockOpContext.anchorTypes`: split/merge refusals, childless-anchor
prune) and the server has no slots.

**Escaping the box is `unwrap`** (`core/block-ops.ts`): Backspace at the start of an
anchor's first child dissolves the container, promoting its children into its slot.

**An outdent never splits a container.** `outdentOne` adopts a block's followers
(Notion) — except when the parent is an anchor: out of a container the block lands
right after the box and its followers stay inside. Every outdent path (empty-Enter,
Shift+Tab, bulk outdent) goes through it.

**Empty-Enter leaves a container only after a blank line.** On an empty line whose
parent is an anchor, the box is left only from its LAST line and only when the line
above is blank too (text-bearing, empty by its live doc, childless): that press is the
`exitContainer` op (blank deleted, caret's line moved after the box — one op, one undo
entry). Elsewhere in the box the outdent rung is skipped: `breakOutOnEmptyEnter` still
applies, then an ordinary split.

### A container folds to its borrowed line

> A collapsed container renders exactly its first visible LINE and nothing else.

`visibleChildRule` (`core/block-ops.ts`): **R1** an anchor always descends into its
first child; **R2** the borrowed line of a collapsed anchor shows no children and no
following siblings. So a collapsed container always paints one line, whatever a raw
`PATCH` or pasted `SerializedBlock` sets `expanded` to.

- **Two encodings, one rule**: `visibleChildrenOf` (flat array — reducer, ladders) and
  `flattenVisible` (built tree — surface). `flatten-blocks.test.ts` cross-checks them.
- **The chevron rides on the borrowed line's ROW and targets the container**
  (`resolveRailSeats`) — an anchor row is zero-height and its controls could never be
  hovered. One chevron slot per line, allocated: a *collapsed* container claims it;
  else the line's own block if it needs one (load-bearing for `collapsible: "always"`
  types, where it drives page MOUNT); else an expanded container with 2+ children.
  Nested containers: only the outermost claims; the rest fold from the rail popover.
- **Content lands where it can be seen**: `applySplit` opens the containers it writes
  into (`revealAround`), as `applyInsert`/`applyPaste`/`applyMove` and both server move
  handlers open their destination.
- **You cannot restructure what you cannot see**: on a collapsed container's borrowed
  line, Backspace-at-start and Shift+Tab resolve to `{type:"expand"}`.
- **A block is born expanded** (every creation path).
- **Read-only surfaces, markdown, copy/paste and search ignore the fold** — collapse
  is editing-surface view state.

## A block id has one mint (`newBlockId`)

`core/block-id.ts` declares `blockIdKind` (`plugins/ids`, `block-<uuid>`) and mints
every `page_blocks` id, client (`insert`/`split`'s `newId`, `wrapInContainer`,
`withMintedIds`) and server (`createBlock`, turn-into-page's seed).
`page-editor/no-adhoc-block-id` keeps it one mint. **An id is opaque** — recognised
via `blockIdKind.pattern`, never destructured: legacy rows keep bare-uuid ids, and undo
of a delete re-inserts under the ORIGINAL id.

## A page's structural writes are one ordered stream over one locked forest

Two invariants: **A is per-page and server-side; B is per-writer and client-side.**
Between two different writers no causal order exists, so A is the complete answer
there. Design:
[`research/2026-08-01-page-structural-write-contract.md`](../../../../research/2026-08-01-page-structural-write-contract.md).

### A — atomicity (server)

> A structural write to a page's forest reads and writes it inside ONE transaction
> holding that page's lock. There is no way to write `page_blocks` without one.

`withPageForest(scopes, fn)` (`server/internal/page-forest.ts`) is the only producer of
a `PageForestTx`; every export of `server/internal/forest-writer.ts` (the only module
that mutates `_blocks`) requires one — an unlocked write is a **tsc error**, importing
`_blocks` around it a **lint error** (`page-editor/no-adhoc-forest-write`).

- **`ctx.forest()` is the only read**, lazy (so "read under the lock" holds by
  construction, and a multi-page delete pays only for forests it reads).
- **Locks in sorted key order** over a deduped set, first statements — the deadlock
  proof for multi-page writers.
- **A scope is `string | null`**; `null` is the workspace root (a real sibling space).
- **`ctx.afterCommit(cb)`** for notify, reindex, re-push — never inside
  (`database/no-pool-await-in-transaction`).
- **Rank parking is unconditional** in `writeForestTarget` (`(parent_id, rank)` index
  is not deferrable); `pairChanged` makes it free when nothing permutes.
- **The writer never hard-deletes** (*Every block delete is a trash*).
  `BlockLifecycle.OnTrash(rows)` runs after commit over the authoritative flagged set;
  `BlockLifecycle.OnDelete(rows, tx)` fires inside the lock only from purge. `rows` is
  authoritative — answer "which were pages" with `row.type`.

### The context both runtimes must agree on

`applyBlockOp` takes a `BlockOpContext` (type facts the forest cannot supply:
`anchorTypes`, `textBearingTypes`, `defaultTextType`). Client and server must mint it
identically or ops never confirm — both go through `blockOpContextOf(handles)`
(`core/block-ops.ts`): `useBlockOpContext()` on web, `blockOpCtx()` in
`handle-apply-block-op.ts`. Pass the CONTEXT through seams, never a bare set (a new
reducer fact is then one field). An ABSENT `textBearingTypes` means *no opinion*
(otherwise every merge would be refused).

### B — order (client)

> One writer's structural mutations reach the server in the order it issued them.

`optimistic-mutation` is an ordered fold, so ordering lives in its per
`(resource, params)` **send lane** (see its CLAUDE.md). The editor's job is **one way
onto that lane**: every structural mutation is a `BlockOp` (or undo/redo `BlockPatch`)
through `BlockStore.dispatch`; `web/block-store.ts` and the composite router are the
only callers of `applyBlockOpEndpoint` / `patchBlocks`
(`page-editor/no-adhoc-structural-write`). Overlay-less writes (detached persist into
a collapsed sub-page, cross-page drag) use `enqueueDetachedWrite` — same lane, no
prediction.

### A rejected write unwinds its undo entry

On a permanent (4xx) rejection the primitive drops the op (toast +
`reports/optimistic-rejection`), and the undo entry is dropped too: every recording
chokepoint (`dispatchOp`, `applyOverlay`, the splice, the mounted merge, `commitRows`)
mints `newHistoryEntryId` and dispatches with `onRejected = dropRejectedEntry(id)`. A
coalescing entry gets no id (its earlier steps did land).

## The caret authority (input follows the model, not the DOM)

> The editor holds ONE authoritative caret location. It moves synchronously with the
> keystroke that moves it. DOM focus is a PROJECTION of it — never the source of truth,
> never consulted to decide where input goes.

`internal/caret-authority.ts` owns the location AND the `BlockFocusHandle` registry,
which is unreachable from the provider: the only way to focus a block is `land()`
(`surgeryOf()` hands back `BlockTextSurgery`, no `focus`). The problem it solves: a
block created by Enter registers its handle in a later passive effect, and keystrokes
in between went to the truncated origin (`"alpha"⏎"bravo"` → `["alphab","ravo"]`).

- **Two states.** *idle* — browser types natively (keeps IME/dictation working).
  *in flight* — the model moved, the DOM hasn't; the authority owns the keyboard.
- **The caret parks on the container**: a claim does `container.focus()` +
  `releaseCaret`, so the origin is no editing host (`preventDefault` is not airtight —
  `insertCompositionText` is not cancelable). Buffered text comes off **`keydown`**
  (`key.length === 1`) plus a `paste` capture; ctrl/meta pass through.
- **`rowsRef` is advanced at each mutation chokepoint (`advanceRows`)**, or two
  mutations in one turn snapshot the same pre-rows and the second reasserts the
  first's columns.
- **KNOWN BOUND: composition input started inside the flight window is DROPPED**
  (`Dead`/`Process` keys carry no character, and there is no host). Fix, if needed:
  shorten the window (`flushSync` + layout-effect registration), NOT make the container
  an editing host.
- **Landing waits for caret-READY, not mount** (a split block's root is childless until
  the pre-seed lands). `CaretLandOptions.onLanded` is the signal (`focusHydratingAware`
  fires it on both branches); `onLandingLost` is the failure dual. **A landing always
  resolves, one way or the other.**
- **Replay must be indistinguishable from typing** (`replayInput` in
  block-text-editor):
  - **one character per commit** (markdown/inline shortcuts fire on single-char
    transitions);
  - **`discrete: true` on every replayed edit** (the next key resolves against
    `getEditorState()`; a microtask commit would split at `position: 0` and wipe the
    doc). `discrete` is only honoured outside an update, so `replayInto` defers the
    loop one microtask;
  - **one microtask yield per entry** (the editor defers work via `queueMicrotask`);
  - **unconsumed keys get their default action**: Left/Right via `selection.modify`;
    unconsumed Up/Down are dropped.

  A replayed Enter re-enters `split()` and claims the next flight.
- **Typing over a text span claims too** (`landWithInput`), to an existing block.
- **Only a block that does not exist yet is claimed.** An existing block with no handle
  (void row, collapsed-away) is queued best-effort without taking the keyboard.
- **Failure is a state.** Bounded push-based (`reconcile` on every commit, never a
  timer) and by focus leaving the surface. On abort the buffer replays into the ORIGIN
  and `caretFlightReportSink` reports (→ `reports/plugins/caret-flight`). The bound's
  driving relation is the **RENDERED line set** (`flatOrderRef`) — not `serverIds`, and
  not "the row exists".

Guardrails: `web/__tests__/caret-authority.test.tsx` (routing, ordering, abort — cannot
model Lexical commit timing) and `e2e/split-typing-verify.ts` (anything about *when* an
edit becomes visible). Design:
[`research/2026-07-31-page-caret-authority.md`](../../../../research/2026-07-31-page-caret-authority.md).

## The caret does not stop at the editor's edge (`CaretSurface`)

The title sits outside the provider, yet ArrowUp/Left/Backspace at the top of the body
land in it and Enter/ArrowDown/Right in the title land in the body. One contract,
`web/caret-surface.ts`:

```ts
interface CaretSurface {
  focus(): void;
  focusBoundary?(edge: "start" | "end"): void;
  focusAtColumn?(x: number, edge: "top" | "bottom"): void;
}
```

Implemented by blocks (`BlockFocusHandle`), the block list (`BlockEditorHandle`) and
host chrome (`<BlockEditor caretBefore>` / `caretAfter`). With neither, a vertical
arrow at the edge lands at the block's own far edge (`landCaretAtOwnEdge`); a
horizontal one does nothing.

- **`landCaret` is the one landing policy** (`internal/caret-landing.ts`); `navigate()`
  calls it identically for blocks and chrome.
- **`focus()` restores, it does not place** (`focusRestoringSelection`) — otherwise
  every Tab re-focus would jump the caret to the start. A caller wanting a position
  says so (`focusBoundary` / `focusOffset`). Spec: `e2e/indent-caret-verify.ts`.
- **`resolveKeystroke` never learns about the boundary**: Backspace at the first
  block's start resolves to `{ type: "nav", dir: "left" }`.

## A void block has no caret to see (`web/components/void-caret.tsx`)

A **void** block owns no editable text (divider, image, bookmark, sub-page row, …). It
shows no blinking caret, and with no registered focus handle `navigate()` would skip it
entirely. So **the editor mounts the caret host, and the registration must say who
holds the caret.**

### Two answers, and no way to give none

`Editor.Block`'s text-less arm requires `caret: "editor" | "renderer"`:

- **`"editor"`** — `BlockRow` wraps the dispatch in `BlockCaretHost`; focusability, the
  cue, ↑/↓, Escape, Backspace and Enter come from the host. For objects the user looks
  at.
- **`"renderer"`** — the block registers its own handle with `useVoidCaret`
  (`code-block`/`equation`'s textarea, `sub-page`'s `Row` control).

No third "nowhere" value. A type with no registration (`unknown`) falls into
`"editor"`. A **container anchor** arm has `caret: never` (it renders no line);
`defineContainerBlock`'s return type states `anchor: true`.

| block | what shows the caret |
| --- | --- |
| text-bearing | the real caret |
| `caret: "editor"` (media, `divider`, `unknown`) | `BlockCaretHost`, mounted by the row |
| `caret: "renderer"` with a text control (`code-block`, `equation`) | the textarea's caret; block owes `useVoidCaret` |
| `caret: "renderer"` delegating (`sub-page`) | `Row`'s `selected`, plus `useVoidCaret` |
| container anchor | its children's |

### What the caret on a media block MEANS

> A media block is **one object in the document**. The caret on it means *this object
> is the current line*, never *you are inside it*.

- **Focus lands on the host** in every render state, never an inner control. Inner
  controls stay reachable and report focus upward (`focusin` bubbles).
- **Backspace/Delete removes the block in one press**; clearing the payload is the
  block's own Remove/Replace button. Caret lands above.
- **Enter**: unfilled → fill it (file picker, URL box, page picker); filled → paragraph
  below. Registered from inside the component with **`useBlockActivate(fn | null)`**
  (`null` legitimate; no-op outside a host). The paragraph type comes from
  `defaultText` (`useInsertParagraphBelow`).
- **Escape enters block-selection mode** (the only keyboard route into a selection
  containing a media block).

### Escapes are unconditional; meanings are the host's own

- **↑/↓ and Escape run wherever they originated**, unless `defaultPrevented` (an inner
  control wanting arrows prevents default, e.g. the place block's suggestion list).
  An origin guard here would trap the caret inside inner controls.
- **Backspace/Delete/Enter/Space are origin-guarded**.

`useCaretEscape(editor)` is the ↑/↓ half alone, for `"renderer"` blocks; a separate
hook (not a field on `useVoidCaret`) because textarea types must NOT take it.

### Focus: three rules, three different questions

`useVoidCaret` moves DOM to the model and has no "already focused?" guard (`.focus()`
on the focused element is a no-op). `BlockCaretHost` adds:

1. **Focus is already inside me** → decline (`contains(document.activeElement)`), or a
   click on an inner button would be yanked back. Cannot see through portals — hence
   `page-link`'s picker opens from `useBlockActivate`, not on mount.
2. **Focus went nowhere** (an inner control unmounted) → reclaim on every commit, but
   ONLY from `null` / `<body>` (never from "outside this row", which would steal from a
   portal).

### The cue is two conditions that LAYER, not one replacing the other

```tsx
className={cn(
  "focus-ring cursor-default rounded-md",
  isFocused && "bg-accent",
)}
```

`focus-ring` answers *DOM keyboard focus* (drawn on exactly the condition the browser
outline was suppressed for); `bg-accent` answers *the editor's caret is here* (same
tint as `Row.selected`, distinct from the selection band `bg-primary/15`).
`page-editor/no-model-focus-ring` forbids a focus/ring/outline class gated on
`isFocused`.

### The host adds no padding, and it counts as row background

It sits at `C` (a decoration); blocks keep their own `<Inset x={BLOCK_INSET}>`. It
carries `data-caret-host`, and `block-editor.tsx`'s `onPointerDown` treats a press on
the host ITSELF as a press on the row (so marquees can start in a media row's margin).
A margin click focuses a void block (no start/end: a void handle has no
`focusBoundary`). A void handle registers `focus` only, no `replayInput` —
`landFlight`'s void arm keys on that absence.

### What a media block still cannot do: carry a caption

Not as a `caption` string: `handle.acceptsText` derives from `"text" in schema.shape`
and decides the registration arm, the forced text renderer and the merge ladders. A
caption must be a child text block.

## Caret geometry is stated in LINE BOXES (`internal/caret-geometry.ts`)

"Is the caret on the first/last visual line" and "place the caret at column x" compare
**line boxes**, never the caret's y against the padded root box (soft lines are
`<br>`-separated runs in one `<p>`; a collapsed Range paints nothing on an empty soft
line or beside a decorator).

- **Every rect read returns a real box or `null`; `null` degrades to the STRUCTURAL
  edges**, never to `onTopLine/onBottomLine = true`.
- **Unmeasurable positions borrow the box of the child at the anchor offset** (the
  `<br>`, the chip).
- **`edgeLineRect` walks leaves INWARD from the edge** (climbing to the parent gives a
  box spanning every line). A `<br>`'s bounding box is the fallback for a trailing
  blank line.
- **A hit-test's `(element, childOffset)` is translated to a Lexical child index**; a
  hit on the RootNode, a `LineBreakNode` or a **decorator** lands *beside* it.
- **`caretLineRect` is exported**; the pending-marks cue anchors to it.
- **Selection reads go through `selectionRange()`** (`dom-selection` primitive,
  enforced by `no-raw-selection-range`); `hasBox` is what `usable()` states.

Spec: `e2e/soft-line-caret-verify.ts`. Crossing a decorator sideways belongs to
`primitives/text-editor/decorator-nav`.

## A mark boundary is a caret position (the virtual delimiter)

> Every inline-mark boundary holds one INVISIBLE ONE-CHARACTER DELIMITER. Rendering is
> unchanged; only the caret and the edit semantics pretend the character is there.

Marks are format bits on a `TextNode`, so a boundary is one DOM point with two
meanings, and a block ending in a marked run trapped the caret. Design:
[`research/2026-08-06-page-inline-mark-boundary-caret.md`](../../../../research/2026-08-06-page-inline-mark-boundary-caret.md).

> **A boundary has TWO caret states, carrying the LEFT run's marks and the RIGHT run's.
> The browser hands you one of them (`natural`). The stop is THE OTHER ONE.**

- **One stop per boundary**: one press crosses it, one Backspace deletes it.
  `virtualStop()` returns direction AND marks from one branch — do not split them.
- **A block edge is an empty unmarked neighbour**, so block start/end/mid-block are one
  code path (`internal/mark-boundary.ts`).
- **The stop asks the LIVE anchor.** A text/text seam resolves to the END of the left
  run (`natural = L`) because of Lexical's `resolveSelectionPointOnBoundary` (a library
  invariant, not a browser quirk; citation in `internal/mark-depth.ts`), so every
  boundary, mid-block included, gets a stop. Keep the direction derived.
- **`left ∩ right` is NOT the stop — it is the deletion's residual**
  (`delimiterDeletion().residual`). Using it as the stop looks right and fails silently
  at `` a|`zz` `` (you could never prepend into a code span). Don't "fix" back.
- **Deletion is split by SIDE** (`before = L \ R`, `after = R \ L`), walked outward
  from the seam's two leaves.
- **Horizontal crossings at a block edge meet the state facing the side they came
  from** (`markArriveFor`'s rule) — see *Every arrival is an announced crossing*.
- **Virtual positions, never real zero-width nodes.** Not for CRDT convergence (that
  argument is false — don't repeat it). Real reasons: a real character breaks
  find-in-page, spellcheck, word selection and the browser's native single-line copy
  (`decideTransfer`'s `{kind:"inline"}` arm); it would enter the plain-text offset
  basis that `$spliceRunsInto` (`core/runs-splice.ts`, used by server text writes)
  splices, so every agent write would delete and re-mint seams; and a Lexical-only
  node is removed by `@lexical/yjs`'s `syncChildrenFromYjs` on every remote sync.

### Every arrival is an announced crossing

> Every mover that relocates a caret **across** something announces the crossing on
> one channel, in the direction of travel. Every consumer of a virtual position
> observes that channel. **A crossing is declared by the mover that knows it happened —
> never inferred from a selection transition.**

The channel is `primitives/text-editor/caret-motion` (a Lexical command, so the
observer runs inline in the announcer's update); this editor's observer is
`internal/mark-arrival.ts`, mounted beside the depth store in `keyboard-plugin.tsx`.
Only the direction travels. Movers today: in-block step (`markArrive`), cross-block
landing (`CaretLandOptions.crossing`), the step across an inline decorator. Clicks,
focus restores, vertical crossings and explicit placements land `natural`. A
transition-derived rule cannot tell a click from an arrow step (e2e phase 10e).

### Depth is STORED, never derived from `selection.format`

"Depth = the caret's format diverges from its node's" is aliased by three shipped
mechanisms: `FormatShortcutsPlugin`'s collapsed toggles (Cmd+E at a run's end),
`applyInlineFormat`'s `preFormat` restore (every autoformat), and programmatic landings
(`TextNode.select()`, `$placeCaretAtLinearOffset`, `appendRunsAtJoin`). A derived depth
makes the next Backspace strip formatting from a whole span. **The trap most likely to
be reintroduced.**

`internal/mark-depth.ts` stores it: `WeakMap<LexicalEditor, anchor>`, **written only by
the `markStep` executor**, **read with verification** (counts only while the live
selection is collapsed at exactly that anchor), **cleared on any update with dirty
leaves**. `selection.format` is the EFFECT, re-asserted from the store by a
`SELECTION_CHANGE_COMMAND` listener.

### The `escaped` gate is the safety property

Backspace's new rung sits at the **top** of the ladder (above `atStart`) and fires
**only when `caret.escaped`** (after our own arrow step in the same interaction); Delete
gets the symmetric rung above `atEnd`. **The ladder below is unchanged.**
`e2e/mark-boundary-verify.ts` phase 4 is the gate (one sub-case per aliasing
mechanism); phase 1 must settle before typing to be non-vacuous. The unmark lives in
`inline-format-surgery.ts` (`removeMarkSpan`), recorded via `recordDocEdit` — one Cmd+Z
restores the mark only.

### `MARK_ORDER` is a storage sort key, NOT a nesting order

Cap-at-1 makes exit order unobservable; don't introduce one. (If ever needed it derives
from `wrappersOf` reversed in `core/inline-markdown.ts`, not reverse `MARK_ORDER`.)

### The one door not taken: marks as inline `ElementNode`s

Settled, don't re-propose: it would make both boundary states stable addresses, but
there is no pending-mark channel for elements (Lexical's only one is the
`RangeSelection.format` bitfield), nesting order becomes observable (and remote applies
skip transforms), and it is a hard CRDT cutover.

### Known bounds

- **A collapsed caret's cue says what it will TYPE with, and only that.**
  `FormatToolbarPlugin`'s second presentation is a chip under the caret showing the
  pending set while the caret is at a mark BOUNDARY (either state) or that set DIFFERS
  from the text it stands in. Typing inside a marked run at a block edge keeps a chip
  (still a seam). **The store decides what a KEY does; `selection.format` decides what
  the SCREEN says** (no contradiction with *Depth is STORED*). Anchors to
  `caretLineRect`. Spec: `e2e/pending-marks-cue-verify.ts`. Design:
  [`research/2026-08-09-page-collapsed-caret-pending-marks-cue.md`](../../../../research/2026-08-09-page-collapsed-caret-pending-marks-cue.md).
- **The inline-code chip cannot carry the cue instead** (settled): both states are one
  DOM position; restyling needs a content write; a fake caret is too fragile.
- **The second component is not restorable** (undo, reload, remote edit → depth 0, the
  safe side).
- **`markArriveFor`'s `offset ± 1` is a character step**, wrong for grapheme clusters.
  Untested.
- **`color` and `link` are not delimiters.** `link` needs nothing; `color` is a gap
  (stepping out of red code leaves the caret red).
- **A mark span across a soft line break is two spans** (`walkNode` emits the break as
  an unmarked run). Don't "fix" it.
- **The MARK model is page-editor only** (`primitives/text-editor` has no marks); the
  crossing CHANNEL is a primitive.

## Visible-line invariants (Enter / Backspace / Delete)

The user's (and caret's) model is the **visible line sequence**, not sibling space.

> Split turns one visible line into two adjacent visible lines: the tail becomes the
> immediately-next visible line; no other line changes position or depth. Merge is its
> exact inverse.

### Split adoption

`applySplit`'s non-`asChild` arm (`core/block-ops.ts`): when the origin has *visible*
children (`expanded` and non-empty), the tail adopts all of them (ranks preserved) and
is opened. Collapsed children stay with the head (which keeps `expanded: true` —
pinned as a decision). Adoption is **derived inside the reducer from the current
forest**, never a flag on the op (ops replay onto refreshed bases). Spec:
`block-ops.test.ts`'s `split ∘ merge round-trip` (structural equality — merge mints
fresh ranks).

### Enter at the START of a non-empty block preserves the origin's identity

At offset 0 with text after the caret, split inserts an **empty sibling ABOVE** and
leaves the origin untouched (id, text, children, doc, `data`, `expanded`); the caret
stays. Discriminator `op.position === 0 && afterRuns.length > 0` (empty-block Enter
still inserts BELOW). Both `applySplit` and the executor (`makeBlockAPI().split`) branch
on it — the executor branch skips `truncateAt(0)`, which would wipe the doc. Spec:
`identity:` cases, `e2e/enter-at-start-verify.ts`.

### The keystroke ladders

`web/internal/keystroke-intent.ts`:

> **Backspace** deletes the nearest visible thing LEFT of the caret: marker glyph
> (convertTo) → **excess** indentation (outdent) → line break (merge) → remaining
> indentation (outdent) → an EMPTY line itself when the line above cannot take a merge
> (removeLine: `unwrap`, children promoted, caret left) → boundary (nav-left).
>
> **Delete** deletes the nearest visible thing RIGHT of the caret: the line break below
> (merge next visible line up) → boundary (nav-right).
>
> **Empty-Enter** escapes one structural level per press: indentation (outdent, keeping
> type) → type (convertTo) → ordinary split. Inside a container see *Empty-Enter leaves a
> container only after a blank line*.
>
> **Enter over a selection REPLACES it** (native range in a line, or a text span): the
> text goes and the line splits where it started, ONE undo entry, empty-Enter ladder
> never runs. The range rides the split op (`KeyIntent.deleteTo`); for a range from the
> line's start (split keeps the origin) an explicit `deleteRange` is recorded on the
> same entry.

- Backspace and empty-Enter order `convertTo`/`outdent` **oppositely, deliberately**
  (marker is nearest the caret; type is the outer layer). Pinned by
  `keystroke-intent.test.ts` (incl. its `trajectories` describe).
- **Only EXCESS indentation is nearer than the line break above**
  (`hasExcessIndentation`: deeper than the next visible line; computed as
  `!hasExpandedChildren && !hasNextSibling`). So the middle rungs swap on that
  predicate. This outdent never adopts followers. Outdent stays as the fallback rung
  below merge (no break above).
- **`readCaretContext` returns `null`** for an anchor it cannot resolve (passthrough),
  never `offset: 0` with `atStart: false`. A **root**-anchored selection is legal (a
  freshly split, childless root) and `$linearCaretOffset` must resolve it.
- **Delete's ladder is deliberately one rung** — nothing of the next block sits between
  the caret and the break.
- **Delete needs no new op**: `mergeNext` merges `nextVisibleLine(this)` up the same
  `mergeBlock` path, valid because `prevVisibleLine(nextVisibleLine(X)) === X` (the
  `duality` property test; hence `prevVisibleLine`'s upward branch). The source's live
  runs come from `BlockFocusHandle.readRuns`; the lagged `runsOfNode` fallback is only
  for text-less blocks.

### Merge's adoption slot follows the same visible-line rule

Adopted children take the merged block's visible position: if the target is its PARENT
(first-child case) they land BEFORE the block's former next siblings
(`Rank.nBetween(null, nextSibling(source)?.rank ?? null, n)`); otherwise they append
after the target's children. Both `PAGE_BLOCK_TYPE` refusals hold.

### The `dataOnSplit` seam

(Checked to-do → unchecked tail, generalized.) Declared on the handle in **method
syntax** (property syntax breaks `BlockHandle<unknown>` assignability — see
`define-block.ts`). Resolved in the **resolver** (only it sees handles), guarded to
`tailType === node.type`; rides as `op.tailData` (absent = inherit). `parseBlockData`
still validates at the write boundary.

### An op's target set is what it WRITES, not only what it names

```text
targets = writtenIds(before, after) ∪ opNamedIds(op)
```

`predictOp` (`web/internal/optimistic-block-ops.ts`) builds it once per dispatch;
`sameOverlayTarget` intersects these sets for the overlay's ordering rule.

- **The union, not the diff alone**: the diff can be smaller (end-of-line split
  rewrites the origin byte-identically; Enter-at-start leaves it untouched).
- **The set is frozen at dispatch**, so at replay the true write set may be larger —
  safe because the relation is a symmetric intersection and an over-match only
  defers; it would invert under a subset test.
- `overlayOpTargets`' doc comment is canonical. `targets` is never read by the
  reducer.

## The selection highlight belongs to the RUN, not to the row

> A row paints **no** selection highlight of its own. The highlight is a sibling
> decoration spanning the grid lines of a maximal run of selected visible lines — the
> same shape as a container frame.

Don't revert to a class per row (N boxes with seams). `internal/selection-bands.ts`
resolves runs, `components/selection-bands.tsx` paints, `block-editor.tsx` calls. A run
splits into touching bands where the decoration edge steps. The band spans `C` → row's
right edge, one `BLOCK_INSET` outside `ContainerBackdrop`'s box.

## The block list is a document, not a listbox

> The container is a **named group of editable blocks**
> (`role="group" aria-label="Page blocks"`). No composite ARIA role is honest here, so
> it claims none.

Every row hosts a `contenteditable`; no composite child role can wear one.

- **Do not add `role="option"` to a row** — it collapses the editing host into a label.
  `aria-safety/no-orphan-composite-role` catches a re-added `listbox`; nothing mechanical
  catches `option`, so this line is the guard.
- **`aria-selected` is unreachable** (only on roles that cannot host a contenteditable).
- **No role swap while selecting** (`contentEditable={false}` deadlocks the caret
  authority's landing).

Replacement channels:

- **The selection is spoken on every range change** — `applyRange`, `selectEveryBlock`,
  `clearSelection` (`internal/use-block-selection.ts`) announce via
  `primitives/announce` (`"Heading 2: Container frames, block 3 of 12, selected"`). The
  host's `describeBlock` names blocks. Unchanged ranges and empty clears are silent.
- **`BlockRow` renders a constant first child** (constant children length;
  `isSelected` is a prop, not a per-row subscription):

  ```tsx
  <span className="sr-only">{isSelected ? "Selected. " : ""}</span>
  ```

Headings get `role="heading"` via *A block type declares its ARIA identity*. Known
bounds: list runs are no `list`, quote/callout no `blockquote` (same section).

## A selected block always carries its children

> The selection is **closed under descendants** — `rangeWithDescendants`
> (`internal/selection-closure.ts`), applied in `applyRange`.

Every structural op acts on subtree roots, so the selection must show what the op will
do. `applyRange` is the ONE funnel for range changes; the reducer stores the closed
range, so bands, `isSelected`, the spoken count and ops all read it. Don't add a second
closure at a consumer.

- **Still one contiguous `[anchor, head]` range** — the closure only pushes the BOTTOM
  end down; selecting a child never selects its parent.
- **An upward range grows at its ANCHOR** (its bottom end).
- **Shrinking below a subtree is not available** (Shift+ArrowUp off a selected parent
  re-closes to the same selection — correct).
- Reads depth from the **visible** flatten.
- **Shift+Arrow moves the head; a plain Arrow leaves from the range's EDGE** (`edge()`).

## Block-selection mode: the container handles only keys it originated

`internal/use-block-selection.ts` (range state + container focus/keyboard policy) takes
its structural surface as an `actions` prop, so it is jsdom-mountable
(`web/__tests__/block-selection.test.tsx`).

> The selection container's `onKeyDown` acts **only** on keystrokes whose `e.target` is
> the container itself. Never `document.activeElement`.

`enterSelectionMode` moves focus to the container mid-dispatch, so an `activeElement`
check claims the still-bubbling key a block already handled. Spec also
`e2e/block-selection-verify.ts`.

The **clipboard** handlers in `block-editor.tsx` keep the `activeElement` check (a
genuine "who owns the clipboard" question) but FIRST decline any `defaultPrevented`
event (a caret paste can claim the caret and focus the container mid-dispatch →
double paste; `e2e/cross-block-span-verify.ts` phase 11).

> Entering block-selection mode **relinquishes the text caret**.

Lexical re-derives the pending selection from the DOM and an untagged reconcile (e.g.
`@lexical/yjs`'s `$ensureEditorNotEmpty`) would `rootElement.focus()` a blurred block
still holding a caret. So `releaseCaret` drops the DOM selection. Consequence: a copy
from a selection-bar BUTTON has no selection and doesn't reach the container's `onCopy`
— `copySelectionViaButton` handles it.

> **The rail never takes the keyboard.** A gutter control ACTS ON a block, so it must
> not become the focus target that ends block-selection mode.

Every control in `block-rail.tsx` goes through `RailButton` (mousedown
`preventDefault`); otherwise the drag handle cleared the selection before dnd-kit
activated and multi-block drags degraded to single moves. **Dragging a block not in the
selection clears the selection explicitly** (`onDragStart`'s non-bulk arm).

### A text drag becomes an editor-owned span at the first boundary

> A drag starting inside a block's text belongs to the BROWSER until the pointer leaves
> the origin row; then the editor takes over with an editor-owned TEXT span — partial at
> both ends — that it holds, paints and edits itself.

Each block is its own editing host and native selection is clamped to it. Design:
[`research/2026-10-09-page-cross-block-text-selection.md`](../../../../research/2026-10-09-page-cross-block-text-selection.md).

**The selection is a union** (`use-block-selection.ts`): nothing, a block range, or a
text span — each setter (`applyRange`, `setTextSpan`) retires the other. During a span
the container holds focus and `releaseCaret` drops the DOM selection; `onSpanKeyDown`
answers:

- **Escape** → the block range of every touched block (the ladder to whole blocks).
- **Delete / Backspace** → `deleteSpan`, caret at the join; plain arrow collapses.
- **Typing over it** replaces it in ONE op/undo step (`joinAroundSpan(…, typed)`;
  Shift+Enter likewise). **Enter** is one entry (`breakSpan`: `deleteSpan` then the
  `split` resolved by `enterReplacingIntent` over `intentContextOf`, both predicted
  before dispatch). Other keys ride the flight buffer (`landWithInput`); a composition
  key lands the caret and starts with the NEXT key (the flight's bound).
- **Shift+Arrow moves the head** (`stepTextOffset`, `goalX` for vertical);
  `normalizeSpan` widens to blocks on a line that cannot end a span.

**Shift+Arrow off a block's edge draws a span** (`extendSpan`,
`internal/keystroke-intent.ts` → `SelectionControl.extendSpan`, anchored at
`caret.offset`, head via `SpanMotion.enter`). `CaretContext.focus` is carried
separately from the anchor. `internal/span-motion.ts` is the keyboard's pure DOM
geometry, handed in as one `SpanMotion` capability.

**`normalizeSpan` (`core/text-span.ts`) is the ONE constructor of a span**: ends in
visible order; both ends text-bearing mergeable lines of one page (else widen to
blocks); offsets clamped and snapped OUTWARD off inline tokens
(`blockTextProtectedSpans()`). Consumers never re-check.

- **Never intercept the text press on the way down** (no `preventDefault`, no
  `focusContainer()`).
- **Read the anchor at promotion, BEFORE `focusContainer()`** (`nativeAnchorOffset`).
- **Re-read the head on every move** (`offsetAtPoint`), re-normalized.
- No one-way rule: a span back inside the origin is just a span there.
- **`select-none` committed synchronously at promotion** (`flushSync`), or the browser
  re-seats a native range for a frame.
- **One selection at a time**: focusing into a block clears the span in
  `onFocusCapture`. Spec: `e2e/span-native-selection-verify.ts` A.

**Edge auto-scroll** (`useEdgeAutoScroll`, `auto-scroll` primitive):

- **One applier, two clocks**: `applySelectionAt(clientY)` runs from `pointermove` AND
  the hook's `onScroll`; `track` is fed from the pointer handler only (else it
  re-latches off its own callback).
- **Engages only once the gesture is ours** (`dragMovedRef` / `textDragPromotedRef`),
  never at pointerdown — the trailing `min-h-40` zone sits in the edge band, and
  engaging on press breaks click-to-edit at the page bottom.
- **`dragStartRef` has two coordinate spaces; don't collapse them**: `x`/`y` viewport
  (for `onEmptyClick`), `contentY` inside `contentRef` (the marquee is its child; the
  `> 3` threshold measures `contentY` too).
- `pointerup`/`pointercancel` share one teardown (cancel skips the click branch). The
  per-move `focusContainer()` uses `preventScroll: true`; `rowAtPointer`'s nearest-row
  fallback keeps the range growing below the last block.

### A native selection lives in an editing surface, or nowhere

> Inside the editable block list, a native text selection may exist ONLY inside a
> block's own editing surface — its Lexical host, or a native control the block brings
> (the code block's `<textarea>`). The surface is `user-select: none` and re-enables
> exactly those (`components/block-selection-scope.css`).

- A property of the SURFACE, not decided per gesture in `onPointerDown` (the branch
  starting no gesture is the one that leaked).
- The exemption (`.block-list-editing-selectable`) drops for the promoted text drag.
- Cross-block text is the editor's span, painted (below); the DOM selection stays
  empty.
- `read-only-view` is deliberately untouched.

### The text span is painted, never native

> A span is OFFSETS (`SpanPoint`: block id + linear offset in the stored-runs basis).
> DOM `Range`s are derived per paint and are never its state.

`components/text-span-highlight.tsx` paints via the CSS Custom Highlight API
(`CSS.highlights`, `page-text-span`). **Selected text is ONE colour, native or
painted**: the theme's `--text-selection` (color-palette `textSelection`) for both
`::selection` and `::highlight(page-text-span)` — never a local tint
(`e2e/span-native-selection-verify.ts` B compares pixels). One Range per covered text
line via the handle's `domRangeOf` (same `$resolveLinearOffset` as the caret).

- **Clamp on re-resolve** (`onTextUpdate`); a span END whose line leaves clears the
  selection.
- **Text-less middle lines keep the row band**; a container the span only enters is
  painted neither way.
- **One registry, many painters** (each pane owns an entry; the `Highlight` is the
  union).

### Deleting a span is ONE op (`deleteSpan`)

`{ kind: "deleteSpan", targetId: A, sourceId: C, runs }`.

One undo entry, one server transaction. `runs` is A's whole result
(`joinAroundSpan`). `applyDeleteSpan` derives the lines strictly between A and C:

1. each is trashed with its subtree, EXCEPT C's ancestors: a plain ancestor is unwrapped
   (its uncovered children lifted), a container anchor ancestor is KEPT;
2. C merges into A by merge's rule (`mergeInto`, shared with `applyMerge`) — or, in a
   kept box, C's children take C's slot;
3. merge's refusals apply on both ends.

Executor: `commitSpanEdit` (`block-editor-context.tsx`) — predict + zoom check, splice
A's doc (`spliceOpenBlockDoc`, in `untracked`), THEN dispatch, one entry with A's runs
edit. A span in one block is just that runs edit, synchronous. Caret lands at the join
one microtask later.

### A span on the clipboard

- **Copy writes a PARTIAL forest as `"text"`** (`spanForest` →
  `writeForestToClipboard(…, "text")`): covered lines, roots via
  `blockSelectionRoots`, end lines trimmed (`serializeForest`'s `runsOverride`), text
  read LIVE (`readRuns`), uncovered visible lines excluded. Being `"text"`, it splices
  on paste. A one-block span copies a plain paragraph.
- **Cut = copy, then `deleteSpan`.**
- **Paste over a span REPLACES it** (`pasteOverSpan` → `replaceSpan`, classified with
  `inline: true`): ONE undo entry — either one `deleteSpan` carrying the pasted text, or
  `deleteSpan` then `splice` planned against the post-delete rows (`planSpliceOn`), both
  predicted first and dispatched under one entry id. On the zoom root, and for a pasted
  FILE, it is two entries.

### A row's pure geometry is background

`TextBlockLayout`'s skeleton boxes (padding box, box, line, marker column) carry
`data-block-chrome`; `onPointerDown` treats a press on ONE of them (identity, never
`closest`) as background, like `data-caret-host`. The glyph in the marker column is
content. Spec: `e2e/gutter-drag-selection-verify.ts`.

### Selecting every line a container owns IS selecting the container

> A container anchor renders no line of its own, so a selection covering every line it
> owns is a selection of the container.

The only way a pointer can say "this card". `withContainersSelected`
(`core/block-ops.ts`) closes the selection over it, and **`blockSelectionRoots` is THE
roots resolver for this surface** (copy, cut, duplicate, drag, move, indent/outdent,
paste anchor). `isAnchor` is required — no anchor-blind spelling.
`primitives/tree.selectionRoots` is reached only through this wrapper.

- Coverage is measured against `visibleChildRule` (a collapsed container is promoted by
  its borrowed line).
- Post-order (nested cards resolve in one pass).
- A childless anchor is never promoted.
- Monotone — only adds.
- The highlight reads the same closed set; it is derived per render, never stored.

Twin of *A selected block always carries its children* (that closes the range downward;
this closes the set upward; they compose). `⌘C` on a bare caret copies the caret's line
(*With nothing selected, the caret's block IS the selection*).

## The gutter `+` and `/` are one unified menu

Both open the same caret-anchored block menu (`components/block-menu-plugin.tsx`), one
`CaretTriggerMenu`, one `BlockTypeList`; only the producer differs:

- **`/`** (`useCaretQuery`): text after `/` filters; commit strips `/query` and
  converts.
- **Gutter `+`** (`useForcedCaretQuery`): `useInsertBlockBelow` inserts an empty
  paragraph and `requestBlockMenu(newId)`; the block force-opens the menu with its own
  text as filter. Commit drops the filter text and converts; Esc keeps the empty line.

`blockMenuDraftId` is the single source of truth for the draft's open state. The draft
type is the `defaultText` handle (`defaultTextHandle`). **No bottom "Add block"
button**, deliberately (every creation runs through a real block with a caret). Commit
is `insertAfter` + `convertTo` = two undo entries, deliberately.

**`Editor.InsertAction`** — entries that RUN rather than convert (`/agent-page`):

- Same menu and ranking (`filterInsertEntries`), placed by `after: <block type>`
  (unplaceable → trailing section).
- Commit strips the query (`stripText`) then calls `run` with the line's runs minus
  the query (`runsWithoutSpan`).
- Offered only on a `serverSync` editor with no `enabledBlockTypes` allowlist, and
  only when the line is `rowTruthOf === "present"` (a server op on an optimistic row
  404s).
- Rows are `InsertEntry` (`{kind: "block"} | {kind: "action"}`); turn-into sees block
  entries only.

## Indent / outdent is a set operation

`indent` / `outdent` carry `blockIds: string[]` (Tab in text = one element; in
block-selection = the selection roots). The folds run in **opposite directions** so a
selection moves as one rigid body:

- **`foldIndent` — top-to-bottom**; a block whose previous sibling is a selected block
  that stayed put refuses (a leading block that cannot indent holds its run).
- **`foldOutdent` — bottom-to-top**; `outdentOne` adopts only UNSELECTED followers
  (never out of a container — *An outdent never splits a container*).

Inputs are sorted with `documentOrder` (rank-ordered DFS). `dispatchOp` drops ops with an
empty diff (no undo/overlay/network). `canIndent` / `canOutdent` run the same fold for
the selection bar.

## Undo / redo (one unified stack)

The editor **does not own the stack**: `<UndoRedoProvider>` (`primitives/undo-redo`) is
mounted per surface tab by `apps-core/tab-surface`; the editor and the Pages sidebar
record into it. One stack for text AND structure — no Lexical `HistoryPlugin` (the row
tree, not a Lexical doc, is the source of truth).

- **Entries are mount-scoped** (`useScopedUndoRedo()`): thunks close over the
  per-`pageId` store and row truth, so they drop on unmount (Cmd+Z does not reach back
  after navigating away). Pure server-call entries (sidebar trash-restore) survive.
- **Keys are routed at the surface**: `TabSurface` mounts one `useUndoRedoShortcuts()`
  per tab; nothing in the editor consumes Cmd+Z/Cmd+Shift+Z/Cmd+Y. The block list
  **claims** them via `surfaceUndoProps` (a text field with its own history keeps its
  keys) — see `primitives/undo-redo`'s *This stack is not the only undo history on
  screen*.
- **Text edits are DATA entries** (`{blockId, before, after}` runs, from the run
  tracker's 500 ms idle window via `recordTextEdit`). No `data.text` autosave path.
- **ONE recorder** (`block-editor-context.tsx`):
  `recordEntry({ label, focusId, before, after, runsEdits?, coalesceKey? })`
  - seals open typing runs, diffs (`diffBlocks`, `core/block-diff.ts`) into minimal
    forward/reverse `BlockPatch`es, pins removed rows' text to their docs, and
    records thunks that re-apply onto the CURRENT state;
  - undo replays runs edits' `before` THEN the reverse patch; redo the forward patch
    THEN `after` (a doc edit always runs while its row exists);
  - `recordStructural` / `recordTextEdit` / `recordDocEdit` wrap it.
- **One single-row chokepoint (`commitRow`)**: `projectText`, `BlockEditorAPI.update`,
  `convertTo`, `setExpanded` call it, so a new type's `editor.update(...)` is recorded
  automatically. Multi-row ops go through `dispatchOp` + `recordStructural`.
- **Same optimistic instance**: patches flow through the same `useOptimisticResource`
  to `POST /api/pages/:pageId/blocks/patch` (`handle-patch-blocks.ts`). Undo/redo thunks
  dispatch patches directly; `record` is ignored during replay. Bound editors never
  re-read `data.text` from a patch.
- **Two patch predicates, deliberately asymmetric** (`internal/optimistic-block-ops.ts`):
  `isPatchAbsorbed` (APPLY-GUARD) must compare `data`; `isPatchReflected`
  (CONFIRMATION) must NOT (`parseBlockData` normalizes, `data.text` lags). Don't merge.
- **A create of a row this client has SEEN in server truth is a restore, judged by
  presence alone under both predicates**: the patch carries `restoreIds`, derived at
  `dispatchPatch` as creates whose `RowTruth` is `"removed"`; `applyPatch` inserts the
  recorded copy only while the row is absent. Pinned by
  `optimistic-block-ops.test.ts`'s *restore creates are presence-only*.
- **A patch's delete cascade reads POST-patch parentage** (server and `applyPatch`
  agree, or redoing an `unwrap` loses promoted children). An id both written and in
  `deleteIds` is a 400.

**Recorded:** every `dispatchOp` op (`paste`, `duplicate`, `move`, `delete`,
`bulkMove`, …), `splice` via its executor, `convertTo` and non-text `data` edits
(`commitRow`, `coalesceKey: blockId`), and text runs. The editor no longer uses
`updateBlock` (`handle-update-block.ts` serves page-level consumers).
`web/__tests__/structural-undo.test.tsx` asserts a QUADRUPLE per mutation (forward
changed rows, `canUndo` flipped, undo restores, redo reproduces) — every mutation
reachable from the context is in its table.

**Not recorded, only these two:** `setExpanded` (view state, `record: false`) and
`projectText` (the doc owns text history).

## Drag and block-selection writes are ops too

- **`move` sends POSITIONAL INTENT, never a rank**:
  `{ blockId, parentId, targetId, zone }`; both sides mint via `positionalRank` (`core/block-forest.ts`), the server's
  authoritative (one `(parent_id, rank)` space is projected disjointly by several
  resources).
- **The destination must be inside the op's page** (`assertDestinationInPage`, 400). A
  **cross-page** drop uses the id-scoped `moveBlock` endpoint (locks both forests) on
  the source page's lane; `moveBlock` also serves the Pages sidebar.
- **`delete` is a SET** (`blockIds`) — one gesture, one op, one entry. The only op that
  may span pages; the composite fans it out (`splitOpByOwnerPage`).
- **`bulkMove`** `{ ids, parentId, afterId }` reduces via `planBulkMove` (refusal =
  identity). A cross-page selection drop goes to `moveBlocks`
  (`POST /api/blocks/move-many`); `resolveOpOwnerPage` throws on a `bulkMove` to
  another page.
- **Cross-page moves ask the DATABASE about cycles** (`server/internal/ancestry.ts`).

## With nothing selected, the caret's block IS the selection

> With NOTHING selected, the caret's own block IS the selection.

`BlockForestCopyPlugin`: Cmd+C copies the caret's block and subtree, Cmd+X copies and
removes it, and a caret Cmd+V of that payload lands it as WHOLE blocks after the line
(`granularity: "blocks"`). A non-collapsed selection declines (native inline copy). Both
plugins sit at `COMMAND_PRIORITY_NORMAL`.

- **One encoding**: `writeForestToClipboard` (`internal/clipboard-write.ts`) is the sole
  writer (`BLOCKS_MIME` + `text/plain` markdown), shared by container and caret copy.
  Not in `internal/transfer.ts`, which stays Lexical-free for unit tests.
- **A cut deletes only if the write returned `true`** (via `editor.remove()`, one entry).
- **It copies the caret's block, never the container around it** (the rail menu acts on
  `RailSeat.owner`; selecting a whole container is *Selecting every line…*).
- **`serializeForest` reads the ROW**, so a copy inside the ~1 s projection window
  carries pre-keystroke text (`e2e/caret-clipboard-verify.ts` waits it out; its phase F
  copies with no settle by design).

### "Nothing selected" is a question for the DOM, not for Lexical

> A clipboard handler asks `selectionIsCollapsed()` (`primitives/dom/dom-selection`) and
> claims only when the model and the document AGREE that nothing is selected.
> **Lexical's model cannot answer this during a copy**: `$internalCreateRangeSelection`
> re-derives from the DOM only for an allow-listed event set, and `copy`/`cut` are not
> in it.

`selectionchange` fires a task later, so a one-step selection (Shift+Home, ⌘A, drag,
triple-click) followed fast by ⌘C reads as collapsed in the model — the plugin used to
copy the whole block (and ⌘X would delete it). **Disagreement declines**, never claims.

## A block is ONE paragraph, and a paste cannot make it two

Each block's Lexical root holds one paragraph (Enter is a structural split; Shift+Enter
is a `LineBreakNode`); every caret/split/merge rule assumes it.
`BlockClipboardInsertPlugin` guards at `SELECTION_INSERT_CLIPBOARD_NODES_COMMAND`
(covers paste, drop and IME insertion of MARKUP flavors).

- **Claims only a payload with block structure** (`isBlockLevel`, `insertNodes`' own
  predicate); otherwise Lexical runs untouched. When it claims, it re-applies the last
  run's marks to the caret.
- Reachable because `text/html` need not agree with the single-line `text/plain`
  `decideTransfer` classified.
- **A boundary with content on both sides becomes a soft break** (`$flattenToInline`,
  lazily — only once something follows).
- **Three arms** (`InlineClipboardContent`): content, `empty` (still replaces the
  selection), `not-inline` (a non-inline decorator → decline).

**The plain-text arm** (`insertParagraph()` per newline, no command) is closed by the
other leg: `decideTransfer` sends any newline text to a forest on caret paste,
block-selection paste and drop.

## The transfer door (one classifier, two gestures)

> A `DataTransfer` entering the page is classified ONCE, by shape, and becomes a FOREST
> unless it is newline-free text AND there is an inline insertion point to take it. A
> forest at an insertion point is SPLICED there; without one it lands as blocks after
> the anchor row. Paste and drop run the same classifier; only the insertion point's
> source differs — the caret, or the pointer.

`internal/transfer.ts` (`decideTransfer` → `file` / `forest` / `markdown` / `inline`)
stays Lexical-free (`transfer.test.ts`). `readTransferText` reads `text/plain`, else
`text/uri-list` (Lexical's own fallback).

**A block owns the caret PASTE; the container owns the pointer DROP** (`rowAtPointer`,
`externalDropPosition`, insertion line, scrim). No per-block `DROP_COMMAND` for
forest/markdown.

- React's root listener runs during the native `drop` bubble, before the default
  action, so `preventDefault()` there cancels the `insertFromDrop` beforeinput.
- **Dragover is TYPES-ONLY** (`dragKindFromTypes`, `internal/drag-kind.ts`: `files` /
  `forest` / `text` / `none` — `getData()` is empty during a drag). So a text drag over
  a block's text shows no scrim; `onExternalDrop` claims it only if it has newlines and
  splices at the pointer (`insertionPointAt` → `BlockTextSurgery.offsetAtPoint`).
  Unplaceable → blocks at the pointer row.
- **A Lexical-marked drag** (`application/x-lexical-drag`) is never claimed.
- **`inline` is answered by the caller**: `true` for a caret paste and a drop inside an
  editing host (`isInsideEditingHost`), `false` for the container paste and drops
  outside text. An inline drop is left to the browser.
- **`inline` means "no newline"** — keeps url-paste, token-paste, html marks native.
  Everything else at an insertion point is a splice.
- **Dropped URLs**: `page/url-paste` registers `DROP_COMMAND` beside `PASTE_COMMAND`
  (bare URL at a collapsed caret, or dropped into an EMPTY block → link + menu) and
  calls `stopPropagation()` — a CRLF-terminated `text/uri-list` would otherwise classify
  as multi-line markdown at the container. `decideTransfer` reads the RAW text (don't
  trim — the native insert would split on the terminator). The drop arm declines on a
  childless (unhydrated) root.

Spec: `e2e/drop-verify.ts`, `page/url-paste`'s `e2e/url-drop-verify.ts`,
`transfer.test.ts`, `drag-kind.test.ts`.

## Paste is an op (`{ kind: "paste", forest, afterId, parentId }`)

> **Identity is minted client-side and travels ON the node.** `withMintedIds`
> (`core/serialized-block.ts`) turns `SerializedBlock[]` into `IdentifiedBlock[]`, and
> `planForestInsert` consumes those ids — so both sides run the same planner and
> produce the same rows (ranks differ; the server's win).

Ids ride the node, not a parallel `ids[]` (a positional array breaks silently on
traversal reorder).

- One write path for forest inserts; the server mints no forest ids.
- **Anchorless paste inserts at the START of `parentId`** (only reachable on an empty
  page).
- **`OpEffect.create.ids` lists ROOT ids only** (one transaction); `writtenIds` lists the
  whole forest for `targets`.
- **A missing anchor refuses the whole paste.**
- `insertScopePageId` is shared by `applyInsert`/`applyPaste`.
- **`paste` is the op WITHOUT an insertion point** (container paste, drop outside text);
  caret pastes and drops into text are `splice`. Both mint via `prepareForest`
  (`withPasteIds` + `claimCutPages` + `markCutsPasted`).

Spec: `e2e/paste-optimistic-verify.ts` (stalls the endpoint; asserts blocks render
first, one POST, no dup/drop, survive reload).

### A paste lands AT the insertion point (`{ kind: "splice", … }`)

> A forest pasted or dropped at an insertion point inside a block's text is SPLICED
> there: the text before the point keeps its line and absorbs the forest's leading
> paragraph; the text after the point goes to the end of the forest's last paragraph;
> everything else lands in between. One op, one undo entry, same rows on both sides.

Split and paste fused (`core/block-ops.ts`, `planSplice`): `runs`/`position`/
`siblingType`/`tailData`/`tailId` mean split's fields; `forest` is paste's. With
`[before, after] = splitRuns(runs, position)`:

1. **Head**: a leading PLAIN paragraph (`BlockOpContext.defaultTextType`) merges into
   the origin; its nested lines become the origin's first children.
2. **Text only**: origin reads `before + head + after`.
3. **Consume an empty origin** (textless, plain, childless): the forest takes its slot.
4. **Body**: lands where split puts its tail (`splitSlot`).
5. **Tail**: non-empty `after` joins the forest's LAST LINE (deepest last descendant)
   if plain, at any depth; else a tail row `tailId`, which adopts the origin's visible
   children.

**Granularity decides how the forest meets the line** — the op's required
`granularity` (`ForestGranularity`), never inferred from shape:

> A block copied WHOLE pastes as whole blocks — never merged into the caret's text.
> Text (external text, markdown, a text range) is spliced into it.

- `BLOCKS_MIME` is an envelope `{ granularity, forest }` (`encodeBlocksPayload` /
  `decodeBlocksPayload`, `internal/transfer.ts`). `writeForestToClipboard` writes
  `"blocks"`; a bare legacy array decodes as `"blocks"`; markdown/plain text is
  `"text"`.
- `"text"` → `splitSlot` (steps 1–5); `"blocks"` → `insertForestAt` after the origin's
  subtree, no head/tail merge (`planWholeLines`). Both consume an empty origin and
  replace a selected range.

Caret lands at the end of the paste (`planSplice`'s `caret`; `opFocusId` agrees).
Refusals: split's plus paste's missing anchor.

- **Text follows split's row/doc division**: only the ORIGIN has a live doc; the
  executor (`BlockEditorContext.splice`) dispatches, lands the caret, and one microtask
  later splices the origin doc (`spliceOpenBlockDoc` in `untracked`), recording both on
  one entry. New rows seed from `data.text`. A consumed origin gets no doc edit. A
  missing live owner throws.
- **A splice that creates no row is not dispatched** — it is `recordDocEdit`'s data
  entry (text is doc-owned). `OpEffect.create` lists rows actually created.
- **Inside a zoom**, a splice on the root line pastes as the root's first children.
- A paste fired in the same task as a one-step selection reads the stale model caret —
  Lexical's behaviour too.

Spec: `core/block-ops.test.ts`'s `splice` suite, `structural-undo.test.tsx`,
`e2e/copy-paste-verify.ts` H–J, `e2e/drop-verify.ts` A/E. Design:
[`research/2026-09-29-page-paste-splice-op.md`](../../../../research/2026-09-29-page-paste-splice-op.md).

### Duplicate is copy + paste-in-place (`{ kind: "duplicate", placements }`)

One gesture = one op = one entry; each placement clones a selection root right after
it via paste's `insertForestAt`. `serializeForest` (`web/serialize-blocks.ts`) is the
one serializer for copy and duplicate.

- A distinct kind because `OP_LABELS`/`opFocusId` key by kind.
- **A dead anchor drops only ITS placement** (paste refuses whole).
- **Placements carry no `parentId`** — keep it so: `translateOpForStore` rewrites
  `parentId` only for kinds that have one.
- Placement order is not load-bearing (document-ordered for determinism).

### A pasted sub-page moves once, and copies after that

A `type="page"` node carries `pageSource: { pageId, cutId? }` instead of children
(`core/serialized-block.ts`); the server resolves content inside the op's transaction
(`server/internal/page-clipboard.ts`).

> A page node whose id IS its source page is a CLAIM: the page itself moves. Any other
> page node is a COPY of the source's whole content.

- **The client decides before dispatch** (the optimistic render names the ids). A cut
  stamps one `cutId` (`writeForestToClipboard(…, "cut")`); `withPasteIds` keeps the
  source id only for a not-yet-pasted cut (`web/internal/cut-claims.ts`, localStorage +
  memory) whose page isn't already in the destination. `withMintedIds` stays
  unconditional, so duplicate always copies.
- **A claim keeps everything keyed on the page's id**: the writer places the stored row
  (`writeForestTarget`'s `claims`); a trashed claim takes back only rows under that page
  from the cut's entry. Claiming the destination or an ancestor is a 409.
- **A copy runs `BlockLifecycle.OnCopy`** per `(source, copy)` in the transaction
  (`editor-collab` copies the content doc, `authorship` its conversations). Facts about
  the SOURCE row (star, TODO binding, agent-origin) don't contribute.
- Content follows the source's state (live rows, or the rows its delete trashed); rows
  this write inserted are never read back as source.

## A write names the fields it changes (`BlockPatch`)

> Restating a whole row asserts authority over fields you don't own.

```ts
type BlockFieldChanges = Partial<
  Pick<Block, "parentId" | "type" | "data" | "rank" | "expanded">
>;

interface BlockPatch {
  creates: Block[];
  updates: { id: string; changes: BlockFieldChanges }[];
  deleteIds: string[];
}
```

- **A single-field writer cannot clobber a field it doesn't own**: `diffBlocks` reduces
  a whole-row `after` to `changedFields(before, after)` and undo inverts exactly that
  set — the diff, not the caller, decides what the patch claims.
- **An update never creates**: an update naming a missing id is a skip (in
  `applyPatch`, `isPatchReflected` — vacuously absorbed — and the server). A create
  matching a soft-deleted row restores that row's WHOLE trash entry, consumes it, and is
  excluded from the write (stored row wins). Confirmed by presence (`restoreIds`).
- Both predicates compare exactly the NAMED fields over one comparator (`dataEqual`,
  the diff's own); they differ only on `data` (above).
- **The server writes only named columns** (`handle-patch-blocks.ts`); `parseBlockData`
  validates against the effective type; `parkRanks` only for `parentId`/`rank` writes.
- **An update carries no `pageId`**: the composite resolves its page from union rows
  (`groupPatchByOwnerPage`); creates route by their own `pageId`.

### Every block delete is a trash (server)

> No write shape ever `DELETE`s a row the user can see. A delete flags its rows under ONE
> ledger entry per gesture; the real `DELETE` runs only at purge (30 days, or "Delete
> permanently").

- **Two sources, one mechanism**: a `type="page"` root mints its own `pages` entry
  (Pages Trash); other rows fold into ONE anchor entry (the first page entry, else a
  `page-blocks` entry — `PAGE_BLOCKS_TRASH_SOURCE`, undo + purge only — carrying
  `{pageId, rootIds, count}`). One gesture is one undo.
- **Where**: a page-free set is trashed INLINE in the write transaction
  (`trashDeletedRows`, `forest-writer.ts`); a set with a page row defers to
  `deleteBlocksSubtree` (takes sub-page locks). Always closed under descendants under
  the lock.
- **Closed over the forest AS WRITTEN, trashed before placing** (rows re-homed by the
  same write stay live; flagged rows vacate their `(parent_id, rank)` slot since live
  indexes are partial on `deleted_at IS NULL`).
- **Ledger invariant: an entry exists ⇔ at least one row carries its id.** Only
  `trashBlockRoots` (with `recordTrashEntry`) sets flags; only `untrashBlocks` clears
  them and deletes the entry. CHECK `page_blocks_trash_flags_agree`.
- **Restore repairs only what changed**: a taken slot re-ranks after the occupant
  (`rankAdjacentTo`); a vanished parent → workspace root. Never fails on collision.
- **A trashed block is not addressable** (id handlers read `liveBlocks`, 404).
- **Readers read `liveBlocks`, never `_blocks`** (`live-blocks.ts`: a drizzle subquery,
  so the SQL still says `from "page_blocks"` for the read-set extractor and change-feed).
  `page-editor/no-unfiltered-blocks-read` flags `.from(_blocks)` / `.join(_blocks)`
  outside the trash machinery (allowlist in `lint/index.ts`); raw SQL reads follow the
  same rule by convention.
- **Trash never touches `page_block_docs`**: `doc-init` on a trashed/restored row
  returns the surviving state — hence the pre-seed keys on `RowTruth`, not "row
  unconfirmed".
- **Derived state re-derives through `OnTrash` / `OnRestore`** (search, backlinks;
  `inline-date` revives reminders). Attachment links stay until purge.

## Text is doc-owned: a row write can never say `text`

> A block's text has exactly ONE owner: its per-block `Y.Doc`. `page_blocks.data.text`
> is a ~1 s-debounced **projection** of it — one writer (`projectText`), one reader
> (the doc-init seed).

`projectText` only accepts `DocSourcedRuns` (see *Projection*). Row text is writable at
**creation** only (a new id has no doc): `insertAfter`, `BlockOp.insert.data`,
`split.tailData`/`runs`, `merge.runs`, `BlockHandle.empty()`, `splice`. An *edit* never
— `RowData` (`core/row-data.ts`, `{ text?: never }`) makes it a compile error for
`BlockEditorAPI.update` / `convertTo`.

Only two row-write functions may name `text`:

- **`preserveText`** (`block-editor-context.tsx`) carries the existing projection across
  `update`/`convertTo` unconditionally;
- **`rowDataOf(data)`** — a blob minus `text` (`handle.emptyRowData()` is the same over
  `empty()`; every convert site seeds from it).

### The rule is a BICONDITIONAL, and it lives at the funnel

> `data.text` is present on a row **iff** its type accepts text.

Both halves are a 400 at the boundary (`parse-block-data.ts` invents neither).
`conformRowText`, applied in `commitRows`, enforces it (so `projectText`'s unmount flush
after a text→void conversion diffs to nothing, and void→text gets its `text`):

- **Only rows this write AUTHORED** (object identity vs `before`) — never sweep other
  rows into this write.
- **`after` only, never `before`** (undo of text→void must restore the text).
- **No registered handle ⇒ no opinion** (not the void branch — stripping deletes
  content). Don't copy `markdown-apply`'s `survivorData` spelling.

**This covers DIRECT row writes, not ops.** Ops reach the strict endpoint without
`commitRows`; their half is in the reducer (`applyMerge` refuses a text-less target;
`page.editor:split-targets-are-text-bearing`). Never conform op output client-side — the
server would 400 and the overlay op would never confirm.

**Stripping text a conversion consumed is a content-doc edit, in this order.**
`convertStrippingText({ blockId, from, to, type, data })` is the ONE primitive (slash
menu, gutter-`+` draft, markdown shortcuts):

1. delete `[from, to)` from the doc via `BlockFocusHandle.deleteRange`
   (`collab-text-surgery.ts`'s `deleteBlockTextRange`, `discrete: true` — the slash
   commit runs inside the menu's own `editor.update()`);
2. `convertRow` writes the new `type` (or wraps, for `wrapOnConvert`).

**The wrap-vs-swap decision belongs to `convertRow`, the shared half** (not
`convertTo`). Strip strictly before the wrap. Spec: `e2e/convert-in-place-verify.ts`.
Backspace-reset / empty-Enter break-out strip nothing — plain `convertTo` with
`emptyRowData()`.

## A text block's presentation is styling plus sibling regions

> Every text-bearing type dispatches the SAME component (`BlockTextRenderer`). A type
> change is a re-style, never a remount.

The element-type chain from the renderer root to `<LexicalComposer>` is constant:
`components/text-block-layout.tsx`. A type declares `chrome` (`BlockChrome`), never a
`component` (a compile error on the text-bearing registration arm):

- **styling** of always-present elements — `padding`, `surface`, `boxClassName` (paint
  only), `inset`;
- **sibling regions** — `regions.{header,start,end,footer}`, given **no `children`**
  (cannot wrap the line); the set is closed by geometry.

Constraints:

- **`chrome` is a STATIC object** (region identity is a module constant; no
  `chrome(data)`). `boxClassName` is the one data-dependent knob and returns a string.
- **Regions are `ComponentType`, not `ReactNode`** (must degrade when `editor` is
  absent; need their own hook scope).
- **Three totality rules** (in `text-block-layout.tsx` — read before editing): every
  skeleton element renders unconditionally and is never a Fragment-collapsible
  primitive; each region occupies exactly ONE children slot; nothing keys or branches
  on `block.type`.
- **`padding` is static, `boxClassName` paint-only** (static `gutterFirstLineCenter`;
  `overflow-*` would change caret scroll semantics).

`BlockTextEditor` is the leaf and is **not exported**. `read-only-view` renders the same
`TextBlockLayout` + `chrome`, swapping the leaf (`RunsRenderer`) and passing no
`editor`. Spec: `e2e/convert-in-place-verify.ts`'s DOM-node-identity round trip. Out of
scope: content aligned to wrapped line boxes, per-type wrappers. Cross-cutting
affordances are `Editor.BlockRegion` slots at the same four positions.

## A block type declares its ARIA identity (`semantics`)

> A block type declares what its line **is** (`BlockHandle.semantics`), separately from
> what it looks like (`textVariant`) and what glyph precedes it (`marker`). The shared
> skeleton turns it into ARIA attributes on the one element whose content is exactly
> the text.

- Carrier: `TextBlockLayout`'s **leaf cell** (marker gutter `aria-hidden`; regions, rail
  and the `sr-only` marker sit outside). Attributes only — the cell stays a `div`.
- On the HANDLE, not `chrome`, so editable and read-only share it. On a void type it is
  a compile error (`SemanticsFor` keys off `TextBearingSchema`).
- **The union is CLOSED** (`core/block-semantics.ts`): the role's required context must
  be nothing (flat forest — no `listitem`, no `blockquote`), and it must not have
  presentational children (no `button`/`option`/`tab`/`img`).
- **`level` tracks the markdown prefix, never `textVariant`.**
- Not on `<ContentEditable>` (would drop `role="textbox"`), not real `<h1>` (per-type
  element types are forbidden).
- The placeholder (inside the leaf) is `aria-hidden`.
- **Gap**: list runs and quote/callout containers want `aria-owns` from a per-run
  zero-height element — a follow-up.

Specs: `core/block-semantics.test.ts`, `web/__tests__/block-semantics.test.tsx`,
`e2e/block-semantics-verify.ts`.

## Per-block CRDT text (unconditional)

Every `BlockTextEditor` binds to a **per-block `Y.Doc`** via `CollaborationPlugin`
(`components/collab-text-plugin.tsx`, `id = block.id`, `shouldBootstrap={false}`,
`editorState: null`) — remote changes are Yjs merges. **Structure stays relational**:
`page_blocks` rows are the tree. A block with no doc lazy-seeds from `data.text`. Plan:
`research/2026-07-07-page-per-block-crdt-plan-b.md`.

The transport seam is `internal/use-collab-block-doc.ts` (the ONLY place that knows how
docs sync), wiring `internal/live-state-yjs-provider.ts`: **in** = the
`blockContentResource` subscription (`applyUpdate` with provider origin — echo guard);
**out** = first-writer-wins `doc-init` (live doc hydrated only from the server's
response) + debounced (~300 ms) `doc-update`.

#### One owner per block, one session per binding

`internal/collab-session.ts` (read its module comment first):

> A block has ONE **owner** (`BlockDocOwner`) — canonical `Y.Doc`, transport provider,
> run tracker — and each mounted binding has ONE **session** (`CollabSession`) holding
> it. The session owns the replica's lifetime, the hold on the owner, and **the single
> retention policy**.

- **`session.end()` is the ONLY deferred teardown**: one macrotask (StrictMode remount
  keeps the replica; `session.retain()` cancels), then push-based onto the binding's
  `disconnect()` while the replica is connected. Order: replica first, owner second.
- **One registry per transport** (`BlockDocs`, `useBlockDocs()` in
  `internal/use-block-docs.ts`): `ContentDocTransport` carries `fetchEndpoint` +
  `socketUrl`. The same id under two transports is two owners. Every id-keyed read names
  its registry: `CollabSession.start(docs, …)`, `blockDocOwnerOf(docs, id)`,
  `closeAllOpenTextRuns(docs)`, `liveRunsOf(docs, block)`,
  `applyBlockRuns({ docs, … })`.
- **Nothing releases by block id** (a session holds the owner reference).
  `blockDocOwnerOf` is the one id-keyed read, for mutation chokepoints and replay host
  selection; a read at record time is a capture.
- **The owner's refcount is private; the run tracker's suppression is a scope**
  (`untracked(edit)`).

#### A session PROVES its hydration, and the proof gates the write path

> What this binding RENDERS equals what this session's replica HOLDS.

`SessionState`: `attaching → hydrating → hydrated | stalled`, monotonic, per session.
Arm chosen at `start()` from `RowTruth`:

- **Locally authoritative** (`"unseen"`, all of memory mode): `attaching → hydrated`
  inside `connect()` — keeps instant split instant; `stalled` unreachable.
- **Server authoritative** (`"present"`, `"removed"`): `hydrating` until the first
  `COLLABORATION_TAG` commit — or the transport's `sync` with nothing renderable (Yjs
  emits nothing for an empty apply).

**The check cannot be synchronous** (the editor is one microtask stale inside Yjs
handlers). Don't force it with `editor.read()` (re-enters `syncLexicalUpdateToYjs`). The
mount probe is `promoteOnly`. Compare `$xmlBasisContentLength()` vs
`xmlTextContentLength()` (agreement witnesses, not character counts) on the session's
own **replica**.

**It gates the WRITE path, never the editing host**: `hydrating` = no projection, no
flush. `contentEditable={false}` would deadlock the caret authority. Open in
`attaching`, `hydrated`, `stalled`; released on `end()` (an unmount always flushes).

**Placeholder**: row non-empty + not `hydrated` + never rendered here
(`BlockDocOwner.everRendered`) ⇒ skeleton (`HydrationPlaceholder`); row empty ⇒
nothing; `stalled` ⇒ right-aligned Retry.

#### A restored row binds to its surviving doc (`RowTruth`)

> The one thing that licenses an instant `data.text` pre-seed is: *this client has never
> seen this block id in server truth.*

Every delete is a trash, so an undo-recreated row is unconfirmed AND has a doc; a
pre-seed would duplicate the paragraph. `internal/row-truth.ts`:

| `RowTruth` | meaning | seed | FK gate |
| --- | --- | --- | --- |
| `"present"` | in `serverIds` now | never | open |
| `"removed"` | in an earlier authoritative push, not now | only on a positive `null` answer | closed until confirmed |
| `"unseen"` | never seen by this editor | instantly at `connect()` | closed until confirmed |

- Derived on the context: `rowTruthOf(id)` over `serverIds` and monotonic
  `everServerIds`. `useCollabBlockDoc` gates `markBlockRowConfirmed` on `"present"`;
  `locallyAuthoritative = !serverSync || rowTruth === "unseen"`.
- Provider facts:
  - `blockRowConfirmed` (doc-init FK gate, one-way latch);
  - `mayHaveStoredDoc = rowTruth !== "unseen"` (readonly pre-seed discriminator).

  `connect()` pre-seeds only when
  `!mayHaveStoredDoc && serverState === undefined && clients === 0`;
  `ingestServerState` pre-applies on a positive `null` for an unconfirmed row.
- **Not a per-call-site `restore` flag**; `restoreIds` reads the same fact at the
  dispatch chokepoint.
- **Residual**: an id created and deleted inside one batched render reads `"unseen"` on
  re-creation.

A flush racing a delete succeeds into the trashed doc; 409 is only purge / vanished doc
row; `doc-init` 404s only after purge.

### Projection + content-doc-aware split/merge

- **`doc → data.text` projection is a pure function of the OWNER** (in
  `use-collab-block-doc.ts`): `owner.runsNow()` = `projectableRunsOf(doc)` memoized on a
  content generation; `xmlTextToRuns` is the same `serializeBlockRuns` walk the editor
  uses, over a headless replica. Debounced ~1 s; through `projectText` (`commitRow`,
  `record: false`); never echoes into an editor; skip-if-unchanged; flushes on teardown.
  - **It may not read an editor — `projectText` takes `DocSourcedRuns`**
    (`internal/doc-sourced-runs.ts`, a brand only `projectableRunsOf` mints → tsc error
    otherwise). Never swap `xmlTextToRuns` for a raw `toDelta()` walk (marks, links,
    decorator tokens would be re-derived wrong); counting may walk raw.
  - **Structural ops read the view; the persisted projection reads the owner** (split,
    merge and `BlockFocusHandle.readRuns` stay editor-sourced — they want uncommitted
    keystrokes).
  - **Flush-then-release is one cleanup in `useCollabDocHold`, in that order.**
- **Split** also truncates the ORIGIN's live editor (`BlockFocusHandle.truncateAt` →
  `internal/collab-text-surgery.ts`, through Lexical). The projection is
  existence-gated against render-fresh rows (`liveRowsRef`), or a deleted block's
  unmount flush resurrects it.
- **Merge** appends the merging block's live runs onto the target's editor
  (`appendRunsAtEnd`, in the target owner's `untracked`), then the structural merge
  trashes the block. Unmounted target: `spliceStoredBlockDoc` first, delete only after
  it lands.
- **The doc-update pipeline reports "Saved"**: the provider's `saveState`
  (`idle | syncing | error` + `lastFlushedAt`, a memoized frozen snapshot) →
  `useReportSync({ label: "text" })` in `CollabTextPlugin`.
  - `syncing` starts at the keystroke.
  - **Offline is `syncing`, never `error`**; only durable HTTP rejections (non-409
    `doc-update`, non-404 `doc-init`) error, loudly.
  - `blockGone` is `idle`. The projection is not reported here.
- **A `doc-update` 409 after sync means the doc row vanished** (purge): re-arm init and
  let a doc-init probe arbitrate — 404 is a quiet terminal stop; success re-creates the
  row from the FULL local doc state (never the `data.text` seed) and resumes.

### CRDT text on the ONE unified undo stack

Design: [`research/2026-09-09-page-data-based-text-undo-entries-v2.md`](../../../../research/2026-09-09-page-data-based-text-undo-entries-v2.md).

- **Every entry is DATA**: structural = `BlockPatch` pair; text = `BlockRunsEdit`
  `{blockId, before, after}`; split/merge/autoformat = one entry with both. Nothing on
  the stack points into a doc's history. A replay failure throws
  (`BlockTextReplayError`).
- **The run tracker records typing** (`internal/block-run-tracker.ts`, owned by
  `BlockDocOwner`): 500 ms idle window closes a run; `recordTextEdit` records it with NO
  `coalesceKey`. Origins by the stated three-origin rule: transport provider,
  `TEXT_REPLAY_ORIGIN`, the binding relay (the user). `page-editor/no-adhoc-doc-write`
  keeps `applyUpdate` onto an owner's doc to the replay host, the two providers and the
  relay.
- **`untracked(edit)`** closes the open run, ignores local transactions inside — used by
  split's `truncateAt`, merge's `appendRunsAtEnd`, `recordDocEdit`. The transaction must
  land synchronously inside (`discrete: true`); a caller inside a Lexical command/update
  listener defers one microtask first.
- **Replay: two hosts, one entry point** (`applyBlockRuns`,
  `internal/block-text-write-stored.ts`): host A splices a live owner in process
  (`spliceOpenBlockDoc`, headless `$spliceRunsInto` under `TEXT_REPLAY_ORIGIN`); an owner
  awaiting its subscription waits for `sync`; host B goes through the server
  (`spliceStoredBlockDoc`: `doc-init` → splice → `doc-update`); an optimistically
  re-created row waits push-based for its `serverIds` confirmation; memory mode with no
  owner writes the row. The stored write takes runs as a function of the authoritative
  current runs.
- **Every removed row's `data.text` is pinned to its doc in the reverse patch**
  (`derivePatchEntry`, when the owner is `docAuthoritative`).
- **Apply-and-report policy**: entries are absolute; if a second writer edited between
  record and replay, apply anyway and report `stale-entry` (`undoConflictReportSink` →
  `reports/page-undo-conflict`). A remote apply inside an open run aborts the run
  (`run-aborted`). Upgrade path: runs-level 3-way merge.
- **Residuals**: replay onto a purged block throws; entries are mount-scoped.
- **The replay caret is DERIVED**: `changedSpanEnd(from, to)` (`core/rich-text.ts`).
- **Inverse pairs are ordered, not absorbed**: an undo then redo before confirmation —
  the overlay's ordering rule makes the redo wait (`sameOverlayTarget` = block-id-set
  intersection; see `optimistic-mutation`'s CLAUDE.md).
- **An op leaves the overlay only for a causal reason**: its own confirmation or Rule-B
  denial (the `op`/`patch` endpoints return `currentTxId`); no miss-limit eviction — a
  non-converging op stays rendered and files a `stalled` report.

### Inline markdown autoformat is ONE data entry

Typing `**x**` (also `__x__`, `*x*`/`_x_`, `***x***`, `~~x~~`, `` `x` ``) bolds `x`; one
Cmd+Z restores the literal `**x**`. So it goes through `recordDocEdit` (closes the run,
edits in `untracked`, records one entry).

- **Deferred one microtask inside `recordDocEdit`** (an update issued from an update
  listener is enqueued past the scope). `applyInlineFormat` **throws** there rather than
  returning `false`.
- **Tag-guarded** (`historic`/`collaboration`/`paste`/`INLINE_FORMAT_TAG`) — else a replay
  (rendered as `collaboration`) re-formats instantly. Plus the exactly-one-char-typed
  rule (stricter than `@lexical/markdown`, which fires on Backspace).
- **Single-`TextNode` scope** + `isSimpleText()` (decorator tokens unreachable). Cost:
  `**see [[page]] here**` doesn't auto-bold.
- **Marks set node-level, `hasFormat`-guarded** (same as `runs-lexical.ts`). Not
  `FORMAT_TEXT_COMMAND`, not `RangeSelection.formatText`.

The delimiter table (`core/inline-markdown.ts`) is **closed core data, not a slot**
(`Mark` is a closed persisted enum); tests pin the marks as `MARK_ORDER` minus
`underline`.

### The same table, read left-to-right

`matchInlineFormat` (typing) and `serializeInlineMarkdown` / `parseInlineMarkdown`
(clipboard/markdown, via `MdSerializeCtx.md` / `MdParseCtx.runs`) share the table;
`ctx.plain` is the raw escape hatch. Read the module header for escaping.

- **`MarkdownContext.protectedSpans` is required.** A masked span becomes its own
  UNMARKED run. `blockTextProtectedSpans()` exists on both runtimes (web extension
  registry, server `Editor.InlineToken`) over the same `core/` regexes.
- **`markdownSpan` (`"protect" | "transparent"`) is separate from `pattern`.** `pattern`
  locates the token; `markdownSpan` says whether to mask it. Masking deletes marks, so
  it is required per family: `[[page:…]]`, `[[date:…]]`, `\(latex\)` protect; the
  active-data bare-id chips do not.
- **The parser mirrors `matchInlineFormat`'s whitespace rules**; the serializer hoists
  boundary whitespace out of marks (`**a **` → `**a** `) so `parse ∘ serialize` is an
  identity.
- **`color` and `underline` get tags** (`<color value="…">`, `<u>`); `link` is
  `[text](url)`.

Traps:

- **"Mark OFF for text typed next" rests on Lexical's ~200 ms
  `markCollapsedSelectionFormat` window** — `e2e/inline-format-verify.ts`'s ` tail`
  assertion is the only net; do not weaken it.
- **`markdown-shortcut-plugin.tsx` carries the same tag guard and advances `prevText`
  BEFORE its early return** (else a phantom transition next keystroke).

Not guarded, deliberately: a `$$` math query can autoformat its LaTeX. Coupling to
`caret-trigger`'s arbiter was rejected (a dismissed trigger would disable autoformat);
the fix is the trigger owner consuming the key.

### The hydration guard (a view may not overwrite what it disagrees with)

`@lexical/yjs` has no read-the-doc operation, so both views can silently fall behind
(symptom: an empty block, fixed by reload). `collab-text-plugin`'s guard detects:

- Two defects, both compared against zero (basis-free):
  - **`shown === 0 && doc > 0`** after a settle window → blind binding;
  - **`synced && doc === 0 && row > 0 && never edited here`** → starved doc.
- **`isSynced` gates the second arm**: the window opens on the sync EDGE (~2 s grace),
  never from mount.
- **Two recovery verbs, by defect**:
  - `blind-binding` → `CollabBlockDoc.rehydrate()` (new session = fresh empty
    replica, bumps `attachGeneration` on the plugin `key`; destructive);
  - `starved-doc` → `refetch()` (`provider.rehydrateFromServer()`, idempotent
    `doc-init` re-read, nothing moves);
  - user `stalled` Retry → `rehydrate()`.
- **A skeleton never paints over text already seen**: `BlockDocOwner.everRendered`
  (monotonic latch from `CollabSession.verifyRendered`), on the OWNER because recovery
  and frame moves reset sessions/mounts. Folded into the one hydration snapshot.
- **A DETECTOR, not a write gate** — reported via `collabHydrationReportSink` →
  `reports/collab-hydration`.

### Hardening

- **Doc-init is gated on `RowTruth === "present"`** (`markBlockRowConfirmed`, one-way,
  lifted by the blocks push). Ungated, a split block's doc-init FK-violates and the
  `initStarted` latch wedges. Failures re-arm `initStarted`; a doc-init 404 (purged) is
  a quiet terminal stop (`blockGone`).
- **Seeds are deterministic**: `runsToXmlText` uses a content-hashed `clientID`, so equal
  runs encode identically. Seed bytes are built ONCE per provider (pre-apply and every
  retry). The pre-seed discriminator is `mayHaveStoredDoc`, never confirmation or effect
  order. Keystrokes before caret-ready are buffered by the caret authority.
- **Split focus under pre-seed**: the origin's deferred truncation carries
  `SKIP_DOM_SELECTION_TAG`; `focusHydratingAware`'s non-empty path passes
  `defaultSelection: "rootStart"`.
- **Offline: queue, never a retry timer.** Network failures re-queue and retry on socket
  reopen, `online`, next push or next edit. Teardown finalizes the owner only when the
  provider is `readyForTeardown`. Known edge: closing the tab offline loses unflushed
  edits.
- **The projection dispatches an UPDATE, and an update never creates** — a vanished row
  is skipped on both sides and vacuously absorbed. The patch's shape is the guarantee.
- **History restore keeps block identity** (`restorePageContent`,
  `server/internal/page-content.ts`; design:
  [`research/2026-09-11-page-history-restore-preserves-block-identity.md`](../../../../research/2026-09-11-page-history-restore-preserves-block-identity.md)).
  - Matches blocks BY ID, hard-deletes nothing: both sides → doc edited; deleted
    since → revived as itself; created since → trashed.
  - Phases:
    1. **Revive** `page-blocks` trash entries (before the lock);
    2. **Structure** via `writeForestTarget` under the lock (a version id taken
       elsewhere comes back as a fresh-id copy);
    3. **Text** via the REQUIRED `writeTexts` param (history passes
       `page/block-text-write`'s `writeBlockTexts`; required because the editor
       cannot import it — cycle).
  - **Sub-pages are never created, revived, deleted or renamed**, only moved.
  - Open editors need no special path.
  - Known bound: a fresh-id copy is re-minted on every restore.
- **The offscreen-merge undo is a splice, not a positional cut** (`$spliceRunsInto`
  prefix alignment); a concurrent append past the join surfaces as `stale-entry`.

## Zoom (`rootId`)

`<BlockEditor pageId rootId>` opens ONE block as the whole editor (root at depth 0,
editable, persisting to the page's rows).

> **The data stays whole; only the view is scoped.** Store, reducer and endpoints work on
> the FULL page. `BlockEditorInner` renders `flattenVisible(subtreeOf(tree, rootId))`;
> `setRows` keeps every row, `setFlatOrder` gets the scoped list.

- **One backstop: `scopeAdmits`** (`internal/zoom-scope.ts`): refuses a write changing
  the root's parent/rank, moving a subtree row out, landing a new row outside, or
  changing an outside row in anything but `expanded`. Runs at `dispatchOp`,
  `applyOverlay`, the mounted merge (BEFORE the append) and `commitRows`. Undo/redo
  patches are exempt. `admits(op)` asks ahead, for affordances.
- **The gesture layer maps onto in-scope ops**: top level is `scope.contentParentId`;
  "below the root" is its FIRST child; the root never drags; selection delete/duplicate
  naming it act on its children; its ⋮⋮ menu hides Remove, Delete, wraps, `TurnInto`.
- **The keystroke resolver sees only the view** (`scopeNodes`, root lifted to
  `parentId: null`) plus `IntentContext.scopeRootId`.
- **A root not in the loaded rows is `gone`** (`subtreeOf` returns `null`), never an
  empty list.
- **Known gaps** (refused, not escaping): `/callout` wrap on the root line strips and does
  nothing; a caret cut of the root copies without removing. `Editor.InsertAction` server
  ops on the root line bypass the backstop.

## In-memory mode (`persist={false}`)

`<BlockEditor persist={false} initialContent={…} enabledBlockTypes={…}>`: no `pageId`,
no server, no network; state discarded on unmount (demos, drafts, previews, tests).

- **One persistence seam (`web/block-store.ts`)**: the provider reads/writes all
  structure through a `BlockStore`. `useMemoryBlockStore` is a synchronous `useState`
  over the SAME pure reducers as `useServerBlockStore`; `serverData === data`.
- **A store is `pending`, then settled — the provider only sees settled.** `BlockStore`
  = `PendingBlockStore | SettledBlockStore`; `BlockEditorProviderInner` takes a
  `SettledBlockStore` (tsc), and `BlockEditorProviderGate` renders loading until the
  base rows land. In the composite, a pending child page contributes NO rows (its anchor
  in `loadingBelow`; a failed first load in `failedBelow` with Retry); an op routed to
  it throws; an undo patch takes the detached path.
- **The store owns rank authority**: `move` takes positional intent plus `computeDrop`'s
  prediction; the server store ships only intent; the memory store uses the prediction.
- **Local-only content docs**: `serverSync` is the ONE flag. Memory mode uses
  `useLocalCollabBlockDoc` + `LocalYjsProvider` (never networks; permanently `idle`).
  Both return `CollabBlockDoc`; undo still works.
- **Attachments gated** (`allowAttachments = serverSync`: excluded from the palette and
  file drop/paste).
- **`Editor.TurnInto` and `Editor.BlockMenuItem` render only when `serverSync`.**

## The inline-token registry exists in BOTH runtimes

A token family (`[[page:…]]`, `[[date:…]]`, `\(latex\)`, active-data chips) declares its
node ONCE in its `core/` via `defineInlineTokenNode`, registers the decorated web twin
with `registerBlockTextExtension`, and contributes the SAME spec object to the server's
`Editor.InlineToken`.

- **`registerBlockTextExtensionSource(() => [...])`** for a set that is itself a registry
  (active-data chips loading in tiers); return STABLE objects (the derived extension is
  cached on identity).
- **Server**: `blockTextServerExtensions()` / `blockTextServerNodes()`, read at call
  time; `markdown-apply` refuses a type with no server node.
- Two contributions may share a node `type` only with the SAME spec object; otherwise
  throw.

### A token family declares its READ-ONLY rendering too

`renderToken` is on the same discriminated arm as `node` and `pattern` (required iff
there is a token), so `read-only-view` is total over the registry.
`blockTextTokenExtension({ id, pattern, node, renderToken, Plugin })` is THE builder (it
erases the typed `(fields: F) => ReactNode` via the family's `fieldsOf`).

- **Returning `null` means "not mine after all"** — the surface paints the raw token
  text, never nothing.
- **`blockTextRenderableExtensions()`** returns the registrations themselves;
  `matchTokens` is generic so a match carries its registration (no join by `id`).

**No consumer may name a family**: `page.editor:no-token-identity-outside-owner` fails
any file outside the family's plugin importing its `pattern:` constant or
`defineInlineTokenNode` spec (governed set discovered from registrations).

### Pasting a token materializes it

`TokenPastePlugin` (`primitives/text-editor/token-extension/node`) is mounted in
`block-text-editor.tsx` AFTER the contributed `ext.Plugin`s — within one priority,
listeners run in registration (JSX) order:

| # | handler | priority | claims |
| --- | --- | --- | --- |
| 1 | `BlockPastePlugin` | NORMAL | a pasted FILE |
| 2 | `BlockForestPastePlugin` | NORMAL | forest MIME, or any multi-line text |
| 3 | `UrlPastePlugin` | LOW (an `ext.Plugin`, registered first) | a bare URL at a collapsed caret |
| 4 | **`TokenPastePlugin`** | LOW | single-line text carrying a token |
| 5 | RichText default | EDITOR | everything else |

A URL over a selected range is `LinkPlugin`'s. `TokenPastePlugin`'s slot:

- **below NORMAL**, so files/multi-line stay structural;
- **not above `UrlPastePlugin`** (the link menu is a shipped affordance; the gates are
  disjoint via `inlineBoundary`'s `(?<!\/)`);
- **above EDITOR**, so tokens don't land as literal text forever.

No CRDT surgery helper — a `PASTE_COMMAND` listener already runs inside
`editor.update()`. **Typing an id leaves plain text** (no convert-as-you-type, by
design).

## Markdown is a LOSSLESS PROJECTION of the forest

> Lenient on parse (foreign markdown pastes as it always did), CANONICAL on serialize:
> anything this codebase emits re-parses to the same forest.

`core/markdown.ts` is the pure orchestrator and never names a block type; its void
fallback is the generic **`tag`** (`<name attrs>…</name>`, body parsed recursively).
`core/markdown.test.ts`'s fuzzed round-trip runs against the REAL registry
(`core/testing/block-handles.ts`): a new block type is added to the GENERATOR (its type
set is asserted equal to the registry's). Design:
[`research/2026-08-03-page-markdown-block-roundtrip.md`](../../../../research/2026-08-03-page-markdown-block-roundtrip.md).

- **Only STRING fields become plain attributes**; everything else is JSON in one `data`
  attribute. Override `attrs` + `parseAttrs` TOGETHER.
- **`body` is declared, never derived** (not from `collapsible: "always"` — `toggle`
  must emit children folded). `"children-when-expanded"` is for `page` alone.
- **The walk takes an explicit "consumed my children" signal**; don't infer it.
- **Typing shortcuts ≠ markdown syntax**: `markdownPrefixes` feeds serialize + parse +
  typing; `typingPrefixes` is typing only (`quote`'s `| ` would be a table row).
  `conversionPrefixesOf` has one consumer (the shortcut plugin);
  `page.editor:block-prefixes-unique` keeps prefixes unique.
- **`prompt` declares `body: "text"`** (text-bearing with no markdown prefix).
- **A blank line IS an empty paragraph — in our own dialect only.**
  `MarkdownContext.blankLines` is required: `"empty-block"` for what we emit and read back
  (`read_page`, `edit_page`, clipboard copy); `"separator"` at the three paste sites (a
  pasted README must not gain spacers). A blank line becomes the previous sibling of the
  block that follows, at its indent; a trailing/leading run is dropped. The empty block
  is minted via `defaultTextHandle`.
- **An empty block a blank line cannot place is PINNED as its tag**
  (`MarkdownContext.emptyBlocks`, required): positions with children, first/last of a
  sibling list, or beside a tag line (`pinnedAt`). `"pinned"` emits the tag (`<text/>`);
  `"blank-line"` keeps the loss. `dropBlankLinesBesideTags` drops such lines from an
  agent's `edit_page` / `write_agent_note` text before parsing.
  - It replaces only the LINE (children still emitted below).
  - A handle with `tagFor() === null` keeps the blank line.
  - `read_page`/`edit_page` (`markdown-apply/server/internal/markdown-context.ts`) and the
    planner (`markdown-apply/core/plan.ts`) are `"pinned"` and MUST agree; the clipboard
    (`web/internal/clipboard-write.ts`) and paste sites are `"blank-line"`.
- **A soft line break is the inline escape `\n`** (in `escapeText`, so every run-text
  path inherits it). Dialect `MarkdownContext.softBreaks`, required: `"escaped"` for the
  agent-facing document and planner (MUST agree), `"newline"` for the clipboard; parse
  decodes `\n` in both.
  - `markdown.ts`'s `line.split("\n")` stays (code-block's fenced serialize is genuinely
    multi-line).
  - **The escaped dialect asserts one line**: `serializeInlineMarkdown` throws on a link
    href or `"protect"` span holding a newline.
  - Accepted cost: a lone `\n` in foreign markdown decodes as a break.
  - A break at the edge of a marked run is hoisted out (`hoistBoundaryWhitespace`) — a
    text edit `subtractNoise` absorbs.
  Design:
  [`research/2026-09-10-page-soft-break-markdown-round-trip.md`](../../../../research/2026-09-10-page-soft-break-markdown-round-trip.md).
- **A paragraph whose words open with a block marker is escaped: `\3. x`.** The
  serializer asks `claimersOf` / `claimOf` (the parser's own dispatch: fence, claimers by
  `precedence`, default text); a claimed line gets one leading backslash.
  - The probe reads the left-stripped line; the text keeps its spaces.
  - **A whitespace-only paragraph is escaped too** (`\ `): no claimer takes it, but the
    blank-line rule would read it back as an EMPTY paragraph — and `edit_page` would then
    refuse every edit to the page as a rewrite of the author's block.
  - **Only the default-text type may be escaped**; any other type whose line is claimed
    elsewhere THROWS.
  - **Two asserts, our dialect only**: a `lines`-branch block emits ONE line unless it
    declares `markdown.fence` or `markdown.lineRun`, and a `lines` line never opens with
    `<`.
  - **A hand-written claimer DECLARES its claims**: `markdown.parseLine` is
    `{ claims, parse }`. `page.editor:markdown-claims-are-escapable` asserts every sample is claimed
    by its declarer and that one backslash makes it unclaimed.
  Design:
  [`research/2026-09-20-page-markdown-line-claim-escape.md`](../../../../research/2026-09-20-page-markdown-line-claim-escape.md).
- **A block with no closing line is a LINE RUN** (`markdown.lineRun`: `claims`,
  line-local `matches(line)`, `parse(lines, ctx) → { data, consumed } | null`) — the
  third claim kind beside `parseLine` and `fence` (GFM tables).
  - To `claimOf` it is a single-line claim on the first line (after fences, before
    `parseLine`), so escaping needs nothing new.
  - The walk collects following lines at the SAME indent that each `matches`; `parse`
    takes the longest accepted prefix; `null` → first line is prose.
  - In our dialect every serialized line must `matches`.
  - Ctx for it: `protectedSpans` on `MdParseCtx` and `MdSerializeCtx`, and
    `MdSerializeCtx.mdLine(runs)` (always the escaped soft-break dialect).
  - `page/table` is the declarer; its CLAUDE.md has the table rules.

### The page tags

`<page id="…"/>` needs a row id, so the serialize walk takes `MarkdownNode` (`id?`) and
`web/serialize-blocks.ts` stamps it; consumers overwrite it (`withMintedIds`) — the id is
provenance, never a destination identity.

- `page-link` owns `<page>` on parse; the sub-page handle's primary spelling is
  `serializeOnly`. **Markdown parse creates a sub-page only as an agent-authored page**;
  `<page id="…"/>` always parses as a link.
- **One row type, two spellings** (`BlockTag.spellings`): `data.author === "agent"` →
  `<agent-page id="…" title="…"/>`; the spelling's `data` preset picks it on serialize
  and is merged on parse (a mismatch throws). Its tagless mint form
  `<agent-page title="…">body</agent-page>` creates a new page.
  `markdownParseTagNames(h)` / `markdownTagNameOf(h, data)` are the shared resolution.
- **Every page pointer carries a title**: `<agent-page>`'s own `data.title`; on `<page>`
  an `annotated` read-only attribute supplied by `Editor.BlockAnnotation` providers (this
  plugin's server, `page-link/server`). `id` first.
- **A body on a parsed `<page>` is a loud rejection.**
- **A page's KIND changes only through its own op, never a data edit.** `PageKind`
  (ordinary / agent `author: "agent"` / instructions `instructions: true` + `global`) via
  `pageKindOf` / `withPageKind`; exclusivity in `BlockHandle.refine`.
  `rewriteBlockData` mints the `BlockDataRewrite` brand every `data` UPDATE needs and
  409s a same-type rewrite changing spelling or `blockAuthorOf`. The other mint is
  `rekindPageData` (`setPageKind`, the header's kind control). Kind is chosen at birth
  (turn-into-page's `kind`, or an `<agent-page>` mint); `<instructions-page>` is
  `pointerOnly`. **History restore keeps the CURRENT kind.**
- **`renamePage`** is the server title write (`{...stored, title}` via
  `rewriteBlockData` under the page row's lock; `requireAuthor` judged under the lock).
- **A page's icon is an emoji** (`PageDataSchema.icon: EmojiSchema.nullable()`).
  `<PageIcon>` draws an `EmojiGlyph`.
  **`setPageIcon(pageId, icon, { onlyIfUnset? }, executor?)`** writes it via
  `rewritePageRow` under the lock (`onlyIfUnset` never overwrites a user's pick);
  takes a handle that can OPEN a transaction.
- **A patch's creates stay in its world**: `applyPageBlockPatch` accepts creates on the
  locked page or a page the same patch creates (else 400); created pages are announced
  (`ForestWriteResult.createdPageIds`).
- A parsed forest is uniformly `expanded: true`.

### Reserved attributes: a tag may carry facts the block does not own

`BlockTag.annotated: readonly string[]` reserves attribute names (e.g. a TODO's task and
status, which live in another table) in both directions; the CALLER supplies values
(`MarkdownNode.annotations` → `MdSerializeCtx.annotations`).

- **Serialize** emits `id`, then annotations in declaration order, then the type's attrs;
  an absent value omits the attribute.
- **Parse** deletes every reserved name before `dataOf`.
- **Values are DISCARDED on parse ⇒ READ-ONLY.**
- Loud: a reserved name colliding with a derived-projection field / `data` / `id`
  throws at resolution (a tag with its own `attrs` may reserve a field — `page` reserves
  `title`); a type's `attrs` emitting a reserved name throws; an undeclared annotation
  (or any, for a LINES type) throws.

`Editor.BlockAnnotation` (server) answers block id → attribute record;
`resolveBlockAnnotations(rows)` merges providers and throws on a double claim.
`markdown-apply` resolves it after `redact`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

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
  - Slot contributors: 53 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `Editor.Block` ×31
    - `Editor.BlockFrame` ×8
    - `Editor.FormatAction` ×7
    - `Editor.InsertAction` ×4
    - `Editor.TurnInto` ×2
    - `Editor.BlockMenuItem` ← `page.open-as-page`
  - Contributes: `IdKinds.Kind` "block"
  - Uses: 91 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×6
    - `primitives/text-editor/caret-trigger` ×5
    - `infra/endpoints` ×4
    - `primitives/css/spacing` ×4
    - `primitives/css/ui-kit` ×4
    - `primitives/dom/dom-selection` ×4
    - `primitives/networking` ×4
    - `primitives/persistent-draft` ×4
    - `primitives/slot-render` ×4
    - `primitives/undo-redo` ×4
    - `primitives/css/control-panel` ×3
    - `primitives/css/coords` ×3
    - `primitives/multi-select` ×3
    - `primitives/optimistic-mutation` ×3
    - `primitives/text-editor/caret-motion` ×3
    - `reorder` ×3
    - `primitives/latest-ref` ×2
    - `ids.IdKinds`
    - `network/live.useLive`
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
    - `primitives/dom/web-storage.defineStore`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
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
    - `BlockPasteContext`
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
    - `resource.declare` "page-blocks.v2"
    - `resource.declare` "page-blocks.v2:rows"
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
    - `ids.IdKinds`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `infra/events.defineTriggerEvent`
    - `infra/trash._trashEntries`
    - `infra/trash.defineTrashSource`
    - `infra/trash.recordTrashEntry`
    - `network/live.ServeAllCollectionOptions`
    - `network/live.serveCollection`
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
    - `agentCodeSpanTokens`
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
    - `page-blocks.v2` (keyed)
    - `page-blocks.v2:rows` (keyed, point)
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
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/collab-doc` ×3
    - `primitives/text-editor/token-extension` ×3
    - `primitives/tree` ×3
    - `network/live` ×2
    - `page/block-entity` ×2
    - `primitives/rank` ×2
    - `fields/date/config.dateField`
    - `fields/json/config.jsonField`
    - `fields/rank/config.rankValueField`
    - `ids.defineIdKind`
    - `infra/endpoints.defineEndpoint`
    - `infra/trash.TrashOutcomeSchema`
    - `primitives/text-editor/token-extension/node.defineInlineTokenNode`
    - `ui/icons/emoji.EmojiSchema`
  - Exports (types):
    - `AgentCodeSpan`
    - `Block`
    - `BlockAudience`
    - `BlockAuthor`
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
    - `DocRankChange`
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
    - `PageBlocksRow`
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
    - `planBulkMove`
    - `planDocRanks`
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
    - `unwrapAgentCodeSpans`
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
  - Imported by: 81 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `page` ×59
    - `apps` ×10
    - `reports` ×4
    - `active-data` ×3
    - `primitives` ×2
    - `conversations/conversation-view/jsonl-viewer/tool-call/page-tools`
    - `debug/slow-ops`
    - `reorder/node-types`
  - Extended by:
    - `apps/pages/auto-icon` (table `page_blocks_ext_auto_icon`)
    - `apps/pages/agent-origin` (table `page_blocks_ext_origin`)
    - `apps/pages/starred` (table `page_blocks_ext_starred`)
    - `page/tags` (table `page_blocks_ext_tags`)
    - `page/annotations/todo/task-link` (table `page_blocks_ext_todo_task`)
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
    - `check-thread-safety/no-blocking-check-work` — `check/index.ts`, `check/no-token-identity-outside-owner.ts` (debt)
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
