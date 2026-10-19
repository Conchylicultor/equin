# markdown-apply

Applying an edited markdown document onto an existing block forest **without
re-minting block ids**, so every block keeps its content `Y.Doc` (and with it the
run tracker's history), its `page_links` edges, its `tasks_ext_prompt_block` link
and every entity-extension row keyed on block id. The editor's
`restorePageContent` is the other whole-page write (history restore), and it holds
the same contract: it matches the version's blocks to the page's BY ID and edits
the survivors' docs rather than replacing them. Both write text through the same
channel, `page/block-text-write`'s `writeBlockTexts`, after their structural
write. Design:
[`research/2026-08-03-page-markdown-apply-to-existing-forest.md`](../../../../research/2026-08-03-page-markdown-apply-to-existing-forest.md);
restore's:
[`research/2026-09-11-page-history-restore-preserves-block-identity.md`](../../../../research/2026-09-11-page-history-restore-preserves-block-identity.md).

## The root is the scope; the page is the transaction

`readBlockAsMarkdown(blockId, {redact})` / `applyMarkdownToBlock(blockId, md)`
take **any block**, not a page. A page id is simply the root at depth 0, so
`readPageAsMarkdown` / `applyMarkdownToPage` are the same call — they exist
separately only to *assert* their id is a page (the snapshot coming back is that
proof), so "this page" cannot silently mean "the page around this block".

> `rootId` bounds everything. `existing` is still the whole `page_id`
> partition — the rank floor and the sub-page pin need rows the walk may not
> reach — but survivors, updates and **`deleteIds` all derive from `oldRows`,
> the walk's output**. One line, no second filter to keep in sync.

The root itself is scope, not content: the walk starts at its CHILDREN, so it
has no line in the document and no write can name it.

- **`pageId` is a second required arg, never inferred from `rootId`.** A nested
  root cannot name its own page; created rows join a *partition*, not a position.
- **`subpage-removed`** — an absent shell is re-homed to `rootId` above the rank
  floor, which is right when the root IS the page and would drag a whole page
  tree INTO the addressed block when it is not. So under a nested root it
  refuses. Unreachable in practice (a scoped read emits every shell in scope),
  which is why it is loud.
- **`redact` filters the WALK and nothing else.** Pruning a row prunes its
  subtree for free; `existing` stays the whole partition, so a hidden row is
  invisible without being absent — it still reserves its rank against a
  collision, and still makes a `ref` naming it `ref-out-of-scope` rather than
  `unknown-ref`. Read and apply take the SAME-shaped option so one function
  serves both; redacting differently would diff against a document nobody saw.
  The engine never learns what a redaction *is*.
- The WRITE is still whole-page: `applyPageBlockPatch` locks the entire forest
  either way, because `(parent_id, rank)` is one ordering space.

## Two channels, because they have two owners

`planMarkdownApply` returns a `BlockPatch` **and** a separate `textEdits` list.
Structure is `page_blocks` rows under the page lock; text is the per-block
`Y.Doc`. The engine never mixes them:

> **A survivor's update never names `text`.** The `data` a survivor's update
> carries always restates the block's CURRENT projection verbatim (the same
> thing `preserveText` does for an editor conversion). A changed text leaves
> through `textEdits`.
>
> **A survivor's update never names `expanded`.** A parsed forest is uniformly
> `expanded: true`, so writing it would unfold every collapsed toggle, callout
> and sub-page on the page, on every apply.

Text for **newly created** blocks does ride `creates[].data.text` — legal and
required: a brand-new id has no doc, so its row is the seed.

The plan is a pure function of current state, so re-running an apply converges.
That is the recovery story for a write that fails between the two channels; do
not add a retry that assumes it saw the previous attempt.

## The page title is a READER-SIDE PREFIX, not a node (`core/page-title.ts`)

A PAGE-rooted read opens with `# <title>` — a string prepended AFTER the
serialize walk and stripped BEFORE the parse. The root stays scope, not content,
and the title handling adds **zero authority of its own**.

- **Emit, strip and parse in ONE module**, for `flatten.ts`'s reason: disagree by
  a byte and the apply is a diff against a document nobody saw.
  `parsePageTitleBanner` is the inverse of the emitter: it accepts a `# ` line of
  unformatted text only if the emitter would write exactly that line for the
  title it reads, so the stored title and the line an agent wrote cannot be two
  different strings.
- **Only `rootId === pageId`.** A banner on a card-scoped read would come back as
  an `# H1` minted INSIDE the card.
- The title goes through the **same inline serializer** as every other line and
  its line terminators collapse to a space, so it cannot forge structure in the
  document the agent acts on.
- **The strip's only test is byte-identity** with the banner built from the
  page's CURRENT STORED title. A rename, a spliced-into banner and the page's own
  first heading are indistinguishable from here, so all of them fall through to
  the planner as a created heading and are refused. A deleted banner strips
  nothing and deletes nothing — it was never a row. A RENAME is decided by the
  caller before the apply, never here: `agent-access`'s `edit_page` reads the new
  title with the parse, puts the stored banner line back so this strip sees an
  unchanged title, and writes the title to the page row separately.
- **Known bound:** deleting ONLY the banner line, on a page whose first block is
  an H1 reading exactly the title, strips that H1 block instead. Telling the two
  apart needs the banner to be a node, which is what this refuses to make it.

## The `<page-meta>` header: the title's read-only sibling (`core/page-meta.ts`)

`readBlockAsMarkdown(id, { meta: true })` opens the document — any root, not
just a page — with a header stating where it comes from:

```
<page-meta kind="page" created="2026-07-14T09:12Z" edited="2026-10-07T18:02Z">
  <tags>                             ← `<tags/>` when the page has none
    <tag name="In progress"/>
  </tags>
  <breadcrumb>
    <page id="…" title="Singularity"/>
    <page id="…" title="Hosted"/>     ← the page holding the root, always last
  </breadcrumb>
  <backlinks>                        ← `<backlinks/>` when nothing links here
    <page id="…" title="Roadmap"/>
  </backlinks>
</page-meta>
# Hosted
```

- **Same contract as the banner**: a reader-side prefix, emitted and split in one
  module, never a node. It goes on OUTSIDE the banner and comes off first.
- **Recognised by STRUCTURE, values ignored** — where the banner is matched by
  byte-identity. Its fields are facts held elsewhere (ancestry, timestamps), so
  they are read-only like a tag's annotated attributes, and a document read a
  minute ago still applies after `edited` moved.
- **`<tags>` is the one WRITABLE section, and this module gives it no
  meaning.** It comes first, emitted from `PageMeta.tags` (`{name, attrs}`,
  `page/tags`' `loadPageTags` via `loadPageMeta`), and is parsed back into
  `ParsedPageMeta.tags` — `null` when the header has no `<tags>` section at all
  (that states nothing), `[]` for `<tags/>`. A `<tag>` line takes `name` plus
  only `new` and `color`, carried unjudged in `attrs`; any other attribute, or
  a line with no name, is a refusal like any unknown line. What a changed list
  MEANS — resolving names against the vocabulary, `new="true"` creating a tag —
  is read off `splitPageMeta`'s `meta` by the caller that owns the write,
  `agent-access`'s `edit_page`, as it owns the rename. The engine never writes
  tags.
- **A malformed header is refused, never skipped** (`applyToScope`'s
  `planOf`): an unknown line inside it could be content an agent wrote there.
- **Opt-in**, because its `edited` time changes on every edit: instructions
  delivery hashes its documents, and a TODO's prompt embeds one.
- `backlinks` is `page/links`' `loadBacklinkSources` (id + title of each live
  page linking here, self-link excluded) — the edges the Backlinks panel lists.
  No snippet: it is text of ANOTHER page, read without that page's audience
  policy, so an agent wanting the context reads the source page itself.
- `kind` is the holding page's `pageKindOf` (`page` / `agent-page` /
  `instructions`). A page-rooted read shows no tag for the page itself, so this
  is the only place an agent reading its own agent page by id learns the page
  is one — without it, the page's prose reads as the human's while the write
  rule treats it as the agent's.
- `edited` is the editor's `readPageEditedAt` — the same expression over the
  same rollup as the `pagesTree` row's `editedAt` behind the page's "Edited"
  label and the Recent lists, so they never disagree.

`BlockScope` carries `title` because `loadBlockScope` is the only place it exists
without a second query — a page's own row is not in its content partition. It
carries the whole `pageRow` for the same reason: a policy walking a chain up past
the scope root needs to ask the page itself whose words it holds (an
agent-authored page is open all the way down), and `assertAcceptable` is handed it
beside the rows.

## Alignment: three passes, weakest evidence last

1. **LCS over identity keys** (`diffArrays`). This is why the engine exists in
   this shape. A page with five identical `- item` lines has five identical
   keys; the pages-history content bucket (`build-diff.ts`, the prior art)
   pops them in arbitrary order, so editing one re-pairs the lot. An LCS pairs
   them **by position**, the only answer available.
2. **Similarity within an alignment gap** — the anchors already assert that this
   region corresponds, so what is left there is an edit.
3. **Similarity across the whole document** — this is what lets a block that
   MOVED keep its id. A move is a removal in one gap and an insertion in
   *another*, which pass 2 can never pair.

**There is deliberately no similarity threshold.** Admission is the gate — same
type OR same plain text — and similarity only ranks. A normalized edit distance
punishes short text for being short (appending one word to `bravo` scores 0.38,
rewriting half a long paragraph scores 0.5), so any cut-off either drops the
commonest agent edit or admits everything anyway; and every pair a threshold
rejects becomes a delete plus a create, i.e. exactly the identity loss this
plugin exists to prevent. Stated bound: replacing a paragraph with an unrelated
one of the same type reads as an EDIT, so per-block metadata follows the
position rather than the words — the call every line-oriented diff makes.

## Asserted identity: pins

A node whose identity is **asserted** (a row id in the document) rather than
inferred (content similarity) is a `pin`, settled in its own pass after the three
content passes. Two sources, one mechanism, one refusal vocabulary:

- a **sub-page shell**, whose `<page id="…"/>` pointer is its only identity —
  or, for an agent-authored page, `<agent-page id="…" title="…"/>`, the
  identified SPELLING of the same `page` row type;
- an **identified card** — a tag declaring `markdown.tag.identified`, which
  round-trips its row id as the reserved `id` attribute. The type set is derived
  from the handle registry via `markdownTagIsIdentified` (any spelling counts —
  `page` is in it through `<agent-page>`), **never named here**.

A stored identified card is pinned even when the document does not name it —
otherwise a tagless `<agent-note>` written beside it shares its byte-identical
void content key and can absorb its row id (and its authorship) through an LCS
ambiguity.

Three refusals, resolved in this order: **`ref-duplicated`** (one row, two
positions), **`ref-out-of-scope`** (a real row the walk cannot reach — another
branch, or redacted; this is what stops a page-rooted edit dragging a hidden card
into scope and MOVING it), **`unknown-ref`**.

A `ref` that resolves must also be the SAME KIND of row as the node claiming it:
a card ref may not pin a page row (its children would be created under the page
with this page's `page_id`), nor a page pointer a card. A page pointer has two
more conditions, both because its content is not in this document:

- **canonical spelling** — the pointer's tag must be the one the stored row
  serializes to, so `<agent-page id="H"/>` naming a HUMAN's page is `unknown-ref`
  (and turning an agent page into a `<page>` link is refused the same way). Only
  the spelling is compared — it is chosen by the preset keys alone — so an edited
  or stale `title` on a pointer is ignored, as a read-only attribute is.
- **no body** — else `ref-out-of-scope`: the page's content lives in its own
  partition, and is written by passing its id as the root.

A matched shell is reposition-only, whichever spelling it came in under. `unknown-ref` gets no "already in
this document" hatch, unlike `<page>` below: an id on an identified tag is *only*
ever an identity claim, so a typo must never quietly become a create.

**There is no `note-removed` twin of `subpage-removed`, deliberately.** A shell
owns another partition the document cannot see, so an omission there destroys
invisible content; a card owns only lines the document shows, so omitting one is
an ordinary, fully-informed delete.

## Sub-pages are never deleted

A shell owns an entire other `page_id` partition. Its identity is its ROW ID,
which `<page id="…"/>` carries and no `data` field does — and the engine reads
that id back **by serializing the incoming pointer node and comparing the line**,
never by naming a block type or a `data` field. The tag is the contract; the
serializer is the only thing that knows how a type encodes its identity into one.
The comparison is id-only: the `title` a `<page>` line carries is an annotation,
and annotations never reach the planner. An agent-authored page's
`<agent-page id="…"/>` pointer pins through the identified-`ref` route above
instead, and is never deleted either.

- A shell **absent** from the incoming markdown is preserved, re-homed to the top
  level after everything the document did place (a rank floor above the highest
  placed rank; history restore re-homes a displaced sub-page the same way). It stays exactly put only when it already sits above that
  floor. Anywhere else it moves, because its own sibling list was re-ranked
  without it and the only interval provably free of a `(parent_id, rank)`
  collision is above the floor. Under a **nested root** this is
  `subpage-removed` instead — see *The root is the scope* above.
- A `<page id="…"/>` that is neither a live sub-page here nor a reference the
  document ALREADY holds is `unknown-ref`. That second half is not a softening:
  the same tag is how an ordinary link-to-page block serializes, so refusing
  every id that is not a sub-page would break every such block on every apply.
  What is refused is *inventing* a page reference, which a pure planner cannot
  verify. Repositioning a shell within its page is legal; naming it twice is
  `ref-duplicated`.

## Minting a page: `<agent-page title="…">body</agent-page>`

A `page` node WITHOUT a `ref` is a page this apply creates — the mint form of the
agent-authored page, the one way a markdown parse produces a page node at all
(`<page>` parses as a link; a human's sub-page is still only ever born through
`turn-into-page`). Research: `research/2026-09-11-page-agent-pages.md`.

- **Partition.** The new page row joins the apply's `pageId` (a page is displayed
  in its parent's partition); everything under it joins the NEW page's —
  `partitionOf(j)` is the nearest strict ancestor page node being created, else
  `pageId`. Nested mints work the same way.
- **Its body is asserted NEW.** Every node of a minted page is pinned to its own
  freshly minted id, so the aligner can never pair it with a stored row. Without
  that, a line in the new body reading like one already on this page would be
  paired by pass 3 and MOVED into the new page with this page's `page_id` — a row
  visible in neither. An identity claim inside a new body (an identified `ref`, a
  pointer at an existing page) is `ref-out-of-scope`: a row cannot move between
  pages. A survivor landing in a new partition is asserted impossible (a thrown
  programming error).
- **Born folded**, as `turn-into-page` folds a page: the one created row that does
  not carry the node's own `expanded`.
- Ranks, the rank floor, the preserved-shell logic and `subtractNoise` needed no
  change: the new body is its own sibling group under a new id, and a baseline
  document holds only pointers, which pin — so it plans no creates.
- `ApplyReport.createdPageIds` names the minted pages, so a caller can tell a page
  from its body. `applyPageBlockPatch` accepts exactly these two partitions (its
  closed-world guard) and announces each created page with its own
  `blocksChanged`.

## Ranks are minimal, per sibling list

Per parent, the longest strictly-increasing subsequence of the survivors' stored
ranks is **fixed** and keeps its rank byte-for-byte; only the complement is
minted, one `Rank.nBetween` per maximal run between fixed neighbours. Reordering
one paragraph costs one rank, not a rewritten sibling list. Where two
subsequences are equally long the choice is arbitrary — the tests assert the
COST (one write) and that applying the plan reproduces the asked-for document,
never which of two equally-minimal answers came out.

**A rank held by a row the walk could not reach is an OBSTACLE, at BOTH mint
sites** (`planSiblingRanks`' `reserved`, and the preserved-shell floor).
`Rank.nBetween` is deterministic, so the midpoint of `(A, B)` reproduces the key
of a hidden row inserted between A and B, byte for byte — the live unique index
then fails the whole apply, on the most ordinary edit there is. A survivor
*leaving* a sibling list is deliberately not an obstacle: its own update vacates
the key in the same transaction. Without `redact` the obstacle set is empty.

An obstacle only picks a run's FLOOR, which is the whole of the resulting
guarantee:

> **Stated bound, unconditional: blocks inserted where a hidden row sits land
> AFTER it, contiguously.**

Either side satisfies the author's intent equally — they could not see the row —
so the tie-break is decided by what else is at stake, and that is CONTIGUITY.
The movers are consecutive in the incoming document; interleaving them around
the obstacles would wedge a human's hidden card inside a sequence the agent
authored as a unit and break the authored order, while buying nothing: the
hidden row sits strictly between the same two visible survivors either way,
which is the only position it can be said to have.

## `StoredRow` is a local structural type

`page/editor`'s `StoredBlock` lives behind its SERVER barrel, which a `core`
module may not import. `core/stored-row.ts` declares the five columns this
engine reads; the server-side caller passes `StoredBlock[]` straight in and tsc
proves the two agree at that one call site.

## The acceptance predicate: what a write may DO (`core/touched.ts`)

`redact` decides what a write may **see**. `assertAcceptable` decides what it may
**do**. They are duals, and both are caller-supplied, so the engine still never
learns what an audience is: one takes rows and returns rows, the other takes a
plan and either returns or throws.

- `touchedBlocks(plan)` flattens the plan to four ids-by-channel lists;
  `boundaryViolations({plan, existing, rootId, boundaryOf, enclosure})` judges
  them against a caller-supplied ROW CLASSIFIER, handed `{id, type, data}` — a
  row may declare through its payload (an agent-authored page is a `page` row
  whose `data` says so), so the chain maps carry `dataOf`, overlaid by the data a
  plan writes. **No block type is named here** — naming one
  inverts `agent-access` → `markdown-apply` into a cycle. It returns violations
  rather than throwing (status and wording are the caller's), and throws for
  exactly one thing: a non-terminating ancestor chain, bounded by
  `existing.length + creates.length`, as `chainToPageRoot` does.
- **`boundaryOf` is THREE-VALUED, and nearest wins.** A row answers `"open"`
  (writes are allowed at and under it), `"closed"` (they are not), or `undefined`
  — it declares nothing and the walk passes through it. `nearestBoundary` stops at
  the first row that declares ANYTHING, not the first that says yes, which is the
  whole of the composition rule: a closed card inside an open one shields its
  contents, and an open card inside a closed one still admits writes. Two values
  could only ever say "allowed at and under this row", so a region the caller
  wants to shield INSIDE an allowed one would have no spelling at all.
- **`enclosure` is what the root sits inside**, required: a chain reaching
  `rootId` with nothing declared answers it. The engine cannot see above its root,
  so the caller resolves it (the policy walks the root's ancestry up through the
  page row) and a default would be a verdict with no evidence behind it.
- **A declaring row is inside itself**, in both directions. That is what lets a
  newly minted OPEN card satisfy its own check — otherwise minting a card is the
  one thing a boundary rule could never allow — and it is also why creating a
  CLOSED row is refused at its own row. So "nothing may mint a card whose words
  are not the writer's" is not a second invariant that can drift: it is this walk,
  with this evidence.
- **Both chains, not just the new one.** created → new, deleted → old,
  updated / text-edited → **BOTH**. A block whose new chain resolves open is not
  thereby legal: re-indenting the page's prose into a card is a MOVE, and since
  the aligner preserves the id of byte-identical text it arrives as an `update`
  naming `parentId` — so an after-only test lets an agent annex the whole page
  into its own card without deleting a character. The old chain resolves against
  PRE-plan maps, so moving a block's ancestor in the same plan cannot launder the
  block through it. The closed answer rides the same two chains and adds no rule:
  writing INSIDE a shielded region fails on the new side, carrying a block OUT of
  one fails on the old.
- **A violation carries the two facts separately**: `{blockId, how, side, reason}`,
  where `side` is `"new"` | `"old"` (which chain failed) and `reason` is
  `"escaped"` (the chain declared nothing) | `"enclosed"` (its nearest declaration
  was closed). One overloaded `reason` field used to carry both, which is why a
  delete's old-chain failure had to be special-cased back to the un-suffixed
  spelling; with `side` broken out, a delete simply has `side: "old"`. `judge`
  reports the new side first and RETURNS on its failure — a write that does not
  land legally is one answer, not two.
- **Field-level, not row-level.** Minting a card re-ranks its prose siblings, so
  `updates` names prose rows in the ORDINARY case: a rank-only (or
  `expanded`-only) update is exempt; `type`, `data`, `parentId`, `deleteIds` and
  text edits are judged. Without the carve-out the predicate refuses the feature.
- **`ApplyBlockOptions.assertAcceptable` runs once, synchronously, after planning
  and strictly before the first `applyPageBlockPatch`**, so a refusal has provably
  written nothing. It gets `{ rows, pageRow }`: the UNREDACTED partition — a
  chain walk needs ancestors the document never showed — and the page's own row
  from the same read, the top of every chain. Deliberately **no exported `plan`/`commit` pair**: a
  caller could commit a plan against rows it re-read, and no type can express
  "these two came from one read".

## An edit is judged on what IT changed (`core/subtract-noise.ts`)

A caller edits by splicing one string into the document a read gave it and
handing the WHOLE document back, so every other block round-trips through
markdown → forest — and wherever that projection is lossy, the loss arrives at
`assertAcceptable` as a write the caller never made. Measured on one real refused
edit: 12 boundary violations, none of them a content write. A policy then refuses
the caller over blocks it never touched, naming one of them and counting the
rest.

So `ApplyBlockOptions.baseline` takes the document the edit was made against.
`applyToScope` plans it through the SAME `planOf` — same rows, same `redact`,
same `MarkdownContext` — and `subtractNoise` drops every write the two plans make
identically. What is left is the edit.

- **Subtract, THEN judge, then write.** A policy must judge what will actually be
  written, and the `ApplyReport` counts the same thing, plus `absorbedWrites` so
  the subtraction is visible rather than silent.
- **`updates` / `deleteIds` / `textEdits` are comparable; `creates` are not.**
  The first three key off existing row ids and the planner is otherwise
  deterministic. Every pass mints fresh `crypto.randomUUID()` ids and a fresh
  `new Date()`, so two passes' creates have no equality to test — and a create in
  the baseline plan would mean the READ invented a block, which must be refused
  loudly rather than absorbed.
- **A baseline that does not plan against its own rows throws.** Nothing the
  caller does can cause that, so it is the engine's bug, not an occasion to
  degrade into an unsubtracted apply that then refuses the caller.
- **Only a caller that EDITED an engine-produced document may pass one.**
  `write_agent_note` composes its document from scratch and passes none: there is
  no round trip to subtract, and a wrong baseline would cancel real writes.

Design: [`research/2026-09-03-page-edit-judged-on-what-it-changed.md`](../../../../research/2026-09-03-page-edit-judged-on-what-it-changed.md).

## The write order (`server/internal/apply.ts`)

Structure first (one `applyPageBlockPatch` = one locked transaction), then the
plan's `textEdits` through `writeBlockTexts`
([`page/block-text-write`](../block-text-write/CLAUDE.md)) — the one
server-side text channel: every doc, then the `data.text` projections as one
patch. The doc-before-row order, why the projection is not optional, the seed
race, the character-level splice and decorator handling are all stated there.

## No MCP tools here: this plugin is the ENGINE

The agent-facing triple — `read_page`, `write_agent_note`, `edit_page` — lives in
[`page/annotations/agent-access`](../annotations/plugins/agent-access/CLAUDE.md),
which is the POLICY over this engine. (`edit_page` was once an export of this
plugin, then deleted; it came back over there under a contract that judges the
diff. That reversal is argued in the policy's own doc — the engine's shape is
unchanged either way.)

The split is not filing. A tool names a concrete block type, which a generic
engine must not, and the two predicates it hands in are POLICY, not projection:

> `redact` decides what a write may **SEE**. `assertAcceptable` decides what it
> may **DO**.

Both are caller-supplied, and neither teaches the engine what an audience is: one
takes rows and returns rows, the other takes a plan and either returns or throws.
So what is left here takes a root, a row filter and a boundary predicate, and a
second policy (export, share link) reuses it without adding a branch.

The end-to-end spec moved too — `agent-access/e2e/agent-access-verify.ts`.

**Agent-origin provenance does not apply, on purpose.** That hook reads
`x-singularity-origin` off an HTTP `Request` and marks whole PAGES an automated
session created, for a 24h sweep. An apply has no `Request`, and the page it can
mint — an agent-authored page — is written through `applyPageBlockPatch`, which
never fires `BlockLifecycle.AfterCreate`. That is load-bearing: the page is a real
document the user keeps, and synthesizing the header (or firing the hook) would
hand it to the sweep.

## `markdownNodesOfRows` and the plan share ONE traversal

The caller serializes with `markdownNodesOfRows` and diffs with the same
`core/flatten.ts` walk. If the two disagreed, the plan would be a diff against a
document nobody ever saw — which is why both live in one module over one
`childrenByParent` index, rather than each re-deriving "rank-ordered DFS from the
root". Both take `rootId`; a redaction must therefore be applied to the ROWS
handed to the walk, never to the emitted markdown.

## Annotations are read AFTER `redact`, and never reach the planner

A tag may declare `markdown.tag.annotated` attributes whose values live outside
the block's `data` (see `page/editor`'s CLAUDE.md). `serializeRoot` resolves them
with `resolveBlockAnnotations` over **the rows it was handed**, i.e. post-`redact`
— so a hidden card costs no provider query and its linked task can never surface
in a document that does not show the card. `markdownNodesOfRows(rows, rootId,
annotations)` stamps a node only where the map has an entry (no `annotations`
KEY otherwise, the structural-identity rule `ref` follows).

**The planner is deliberately untouched.** A void card's alignment key is
`type ␀ stableJson(data)` and an annotation is by definition not in `data`, so
dispatching an agent from a TODO changes what the card SAYS without changing what
it IS — the card keeps its row id and its rank through the next apply. An
annotation in the key would make every status change look like a new block.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Apply an edited markdown document onto an existing page's block forest without re-minting block ids: the block-scoped read, the structural patch, and the per-block text edits (written through page/block-text-write). Audience-agnostic — the agent-facing tools over it are page/annotations/agent-access.
- Server:
  - Uses:
    - `database.db`
    - `database.DbExecutor`
    - `infra/endpoints.HttpError`
    - `page/block-text-write.writeBlockTexts`
    - `page/editor.applyPageBlockPatch`
    - `page/editor.blockTextProtectedSpans`
    - `page/editor.Editor`
    - `page/editor.liveBlocks`
    - `page/editor.PAGE_BLOCK_TYPE`
    - `page/editor.readPageEditedAt`
    - `page/editor.resolveBlockAnnotations`
    - `page/editor.serializePageContent`
    - `page/editor.StoredBlock`
    - `page/links.loadBacklinkSources`
    - `page/tags.loadPageTags`
  - Exports (types):
    - `ApplyBlockOptions`
    - `ApplyReport`
    - `BlockScope`
    - `BlockScopePageRow`
    - `ReadBlockOptions`
  - Exports (values):
    - `applyMarkdownToBlock`
    - `applyMarkdownToPage`
    - `loadBlockScope`
    - `readBlockAsMarkdown`
    - `readPageAsMarkdown`
    - `serverMarkdownContext`
- Core:
  - Uses: 29 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `page/editor` ×28
    - `primitives/rank.Rank`
  - Exports (types):
    - `BoundaryViolation`
    - `ClassifiedRow`
    - `InertBlocks`
    - `MarkdownApplyArgs`
    - `MarkdownApplyPlan`
    - `MarkdownApplyResult`
    - `PageMeta`
    - `PageMetaTag`
    - `PageTitleBannerParse`
    - `ParsedPageMeta`
    - `StoredRow`
    - `TouchedBlocks`
    - `TouchedHow`
    - `WriteBoundary`
  - Exports (values):
    - `boundaryViolations`
    - `documentOrderRows`
    - `dropInertNodes`
    - `dropInertRows`
    - `markdownNodesOfRows`
    - `pageMetaHeader`
    - `pageTitleBanner`
    - `parsePageTitleBanner`
    - `planMarkdownApply`
    - `planWriteCount`
    - `splitPageMeta`
    - `stripPageTitleBanner`
    - `subtractNoise`
    - `touchedBlocks`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
  - Imported by:
    - `page/annotations/agent-access`
    - `page/annotations/instructions`
    - `page/annotations/todo/task-link`

<!-- AUTOGENERATED:END -->
