# editor — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

## The sidebar's ordering space is `docRank`, not `rank`

References:
[`research/2026-07-16-page-sidebar-document-order.md`](../../../../research/2026-07-16-page-sidebar-document-order.md),
and for the column
[`research/2026-10-08-global-page-tree-and-agents-routed.md`](../../../../research/2026-10-08-global-page-tree-and-agents-routed.md)
§2, §4.1.

**Why a stored column, not an order minted per read.** Minting the order on
every load (`Rank.nBetween` over every group) cannot be carried by a routed
collection:

- one page insert re-keys every sibling;
- dragging a toggle that holds a sub-page moves the sub-page with no write to
  its row, so nothing would route.

A maintained column turns a reorder into an ordinary write of the rows that
moved.

**Why marks at the lowest-level mutators.** Every composite writer inherits
them; nothing above the mutators has to know they exist, so a new writer cannot
forget to mark.

**Cost the design buys.**

- A data-only write (the typing projection, a rename, an icon, a fold) marks
  nothing: 0 queries. `docRank` derives from ranks, not content, so the ~1s
  `data.text` projection never re-mints.
- A structural op in a page with no sub-pages: one indexed CTE returning
  nothing.
- A drag that reorders k sub-pages: one UPDATE of at most k rows —
  `planDocRanks` keeps the longest increasing run precisely to minimise the
  rows rewritten.

**What boot drift means.** A key change at boot (other than the first backfill)
is a writer that bypassed the marks, or an old backend writing during a
hot-swap. The boot pass re-plans under the groups' locks so it cannot race a
live writer. It is idempotent.

**`touchedBy: false`.** Without it, a sibling re-spaced around a drag would jump
to the top of Recent pages.

**`pageBlocks` carries no `docRank`** because that collection orders by `rank`
inside one `(parent_id, rank)` space, where `rank` is meaningful.

**Membership off the plain select.** A page whose path cannot resolve still
keeps its row and a key. Only corruption reaches that branch (a live page
cannot point at a trashed parent), but making membership depend on the
traversal would silently drop the page from the sidebar.

**A missing `doc_rank` is an error, not a read-time mint.** It means a write
bypassed the marks; the next structural write in that group, or the next boot,
repairs it. Minting at read time would hide the bypass.

## The page tree is a routed collection (`pagesTree`, key `pages.tree`)

**Why a leaked NULL `docRank` fails the whole tuple.** The binding states no
non-null claim: the `all` compiler refuses an `expr` that is exactly one
column, and a base column's nullability is not checked. So a NULL is caught
where it lands — the row schema's `RankSchema` fails the load or refill and the
sidebar shows the error, rather than one row silently sorting anywhere.

**Why `editedAt` reads a rollup.** A content edit stamps only the edited
block's row, never the page row, so the page's own `updated_at` misses typing.
The rollup is per page, indexed on `page_blocks_page_id_idx`: a typing write
re-aggregates one page and refills its one row.

**Costs** (pinned by `server/internal/pages-tree-oracle.test.ts`):

- a content block's write (typing projection): its page's refill;
- a write the rollup does not read (a fold toggle): nothing;
- rename / icon / cover / kind: that page's refill;
- a toggle drag: refills exactly the pages the reconcile re-minted;
- create or restore: one refill and one `orderOf`;
- trash: an exit after a one-id probe (the `where` reads `deleted_at`).

**Why a fresh key.** A tab running an old bundle is refused `unknown-key` — the
skew / Reload prompt — instead of being handed keyed deltas its non-keyed read
cannot apply.

**`blockLocations` reaches no reader on a content edit**: only its projected
columns (`id`, `type`, `pageId`) route.

## A page's forest is a scoped collection (`pageBlocks`, key `page-blocks.v2`)

**Why the typing projection touches one page.** The change carries `page_id` as
a key, and the router matches it before loading. Other costs: an insert or rank
move is one refill and one `orderOf`; a trash an exit (one-id probe); a restore
an entrant; a cross-page move an exit there and an entrant here; never a full
load.

**Why the key must change when the read becomes keyed.** Under an unchanged
key, an old tab's sub-ack still parses (the wire rows are `Block`s), but the
first keyed `delta` throws in its non-keyed read ("no keyOf registered"): it is
reported, the page freezes, with no resub and no Reload prompt. A new key is
refused `unknown-key`, which is a `skew` verdict the client handles.

## The page column (one owner for the content-left edge)

**Why decorations paint the content box, not `C`.** An ordinary decorated block
paints inside its own `<Inset x={BLOCK_INSET}>` content box. When container
frames instead painted at `C`, a callout's tint stood one `BLOCK_INSET` to the
LEFT of every paragraph and every other decorated box — "the card looks
shifted". Frames now take `C` and add `BLOCK_INSET` once, so every decorated box
lines up with the prose.

**Why padding is its own declaration.** Alignment places the edge and has no
opinion about padding. With nothing declaring padding, the four sides of a card
disagreed by 24px (see *A card's padding is declared, not left over*).

**Why the highlight and diff rail stay at `C`.** A highlight wants padding
around the thing it highlights; a box wants to line up with the prose.

**Why a framed row seats its rail at the outermost frame's edge.** A container
that owns no text (the callout anchor) paints its decoration in the
`BLOCK_INDENT` column at its own `C` — exactly where its first child's chevron
would sit under the naive rule. The child's row comes later in DOM order at the
same `z-raised` level, so the decoration would be not merely overlapped but
unclickable.

**Why span and ownership are separate rules.** Conflating them was the bug that
motivated the `RailSeat` abstraction: every row in a frame seats at the frame's
edge, but only the borrowed first line transfers ownership.

**Why `BLOCK_GUTTER` is not exported.** A host that re-adds it to its own
wrapper's padding drifts the title off the block text's edge.

## Container frames (the one exception to the flat list)

**Why a frame cannot use flow padding or a left border.** Rows seat their gutter
controls against a content edge the surface computed (the frame's, for rows
inside it). Shifting the flow would strand them.

**The accepted cost of frames.** Moving a block into or out of a frame changes
its DOM parent and remounts its Lexical instance. It fires only on that
transition, never per keystroke, and the content owner outlives the remount so
text survives.

**Why a foot is a field, not a third decoration seat.**

- A decoration answers *what is this box*: it floats and reserves no space. A
  foot is chrome the box makes room for: a chip row that wraps to two lines
  grows the card instead of overlapping its last line, and the bottom pad moves
  below it.
- Folding it into the decoration union would force a card to choose between a
  name and a foot, and would change what `page-editor:anchor-has-decoration`
  pins.

**Why it renders in the last covered row's grid cell.** The frame already spans
that grid line, so the wash covers the foot with no change to
`computeFrameSpans` or any `gridRow` arithmetic.

**Accepted consequences, and why they are not solved.**

- A selected card (or its selected last child) highlights the foot too. The
  alternative is a per-foot grid line and a remap of every explicit grid
  placement — a large blast radius for a highlight one line tall.
- A card whose last child is another card ends on the same grid row, so the
  inner box paints over the outer foot. A backdrop spanning a grid line cannot
  end above flow content inside that line; this is a property of the placement,
  not of the pad arithmetic. The nesting seen in practice is the other way round
  (a footed TODO inside an agent-note), which lands correctly.

### A card's padding is declared, not left over

**The failure it prevents.** With box edges and content edges computed
independently from alignment quantities, the padding was whatever fell out. A
`/todo` card measured 24px left, 0 right, 0 top, 0 bottom — text on its own
tint, which reads as a clipping bug.

**Why the right gap was zero.** The frame pulled its edge in by the SAME count
the rows reserved as `padding-right`, so reserve and pull landed on one x. One
count where two are needed — hence "two counts, one apart".

**Why Y differs from X.** X is not a choice: the children are one indent deeper,
so the left gap already is `BLOCK_INDENT`, and the other sides are made to
agree. A vertical gap is measured to a line box that already carries the row's
`py-xs` plus half its leading, so equal numbers would not read equal.

**Why the frame has its own `topInset` / `bottomInset`.** Every anchor row is
zero-height; without a nesting share every box in a nest would share one top
edge.

**Why a frame closes on a slot.** A foot renders after the last row, still
inside the box. Closing on the row would land the pad between the card's last
line and its chrome, leaving the card no bottom edge. Worked example — a TODO
ending an agent-note, both padded:

```text
[content][gap][chips][todo pad][note pad]
```

With no foot declared the rule degenerates, byte for byte, to "the last row
closes it". The reverse nesting must stay asymmetric: the outer foot renders
after the inner card's last row and is outside the inner box entirely.

**Why `firstLinePad`.** Without it, the rail's buttons seat in the card's top
padding instead of beside its first line.

**Why `"rule"` frames pad nothing.** A bar has no edge to clear, and a pad would
only narrow its passage. Filtering them before counting means a card nested in
a quote is padded exactly once, by itself.

### A container that owns no text: the anchor row

**Why the first line is a child.** Converting that child to a heading cannot
touch the container, and Enter inside it is a plain sibling split rather than a
second callout.

**Why a childless anchor is not zero-height.** A childless container spans only
its own row (the box must not blink out on collapse); at zero height that is a
0px frame over a 0px row — an invisible, unclickable, undeletable ghost.

**Why `expanded` can stay live on an anchor.** A collapsed container always
paints its borrowed line and that line carries the chevron, so an anchor can
never fold itself out of reach.

**Why decorations are mounted by the surface but declared on the frame.**
Declaring them on the `Editor.BlockFrame` contribution keeps them from drifting
from who actually paints a box; mounting in the row layer keeps them clickable
(a control in the frame layer is hit-tested under the following row).

**Why a hover store and not `group-hover`.** A frame is a grid sibling of its
rows, so no ancestor holds both. Rows write the store and only decorations read
it, so a pointer crossing a long page re-renders no row.

### The rail's menu dispatches by owner

**Why container *Turn into* lists only `from`-targets.** A void container owns
no text, so a generic type conversion has nowhere to put its children. A target
written for the container's type knows where they go (the agent card's *Agent
page* turns its first line into the title, via turn-into-page's
`title: { fromFirstChild: true }`).

**Why `Remove <label>` is generic.** Its wording comes from `handle.label`, so a
new container type wires nothing here.

**Why appearance shows in both the decoration popover and this menu.** The rail
is where a user looks for block actions; the decoration is where they look for
the decoration.

**Why Backspace at the anchor's first child is `unwrap`, not outdent.** The
generic `isIndented` → outdent rung would move that child *below* the rest of
the box (out of a container, an outdent adopts nothing and lands after the
box).

**Why an outdent never adopts out of a container.** A container's children are
the box's content, not a subtree of the line above them. Adopting would carry
them out under the escaping line, painting the box cut in two around it.

**Why empty-Enter needs a blank line above.** Inside a box one empty line is
just a paragraph break (`xxx ⏎ ⏎ yyy` keeps the blank), while `⏎ ⏎ ⏎` at the
end of the last line leaves the box with no stray blank left behind, in one op
and one undo entry. `/callout` + Enter on a fresh empty line therefore does not
dissolve the box.

### A container folds to its borrowed line

**Why folding to a line.** It makes folding a container the rule every block
already follows ("hide everything below my own line"): nothing on screen moves
when it folds, and content can never hide behind nothing.

**Why two encodings are cross-checked.** A drift between `visibleChildrenOf`
and `flattenVisible` is the editor showing lines the ladders think are hidden.

**Why the chevron cannot live on the anchor row.** Gutter controls are
`pointer-events-none` until their row is hovered, and an anchor row is
zero-height — collapse would be unreachable while expanded.

**Why `applySplit` reveals.** Splitting into a folded container once landed the
tail among the folded children with no row and no Lexical instance, while the
executor had already truncated the origin's doc: the text after the caret
vanished.

**Why Backspace / Shift+Tab expand first.** On a collapsed borrowed line, unwrap
would spill the hidden lines into the document and outdent would adopt them as
the escaping block's children. One structural level per press.

**Born expanded is hygiene, not the safety mechanism.** It makes a collapsed row
provably the user's act; the guarantee is the line a collapsed container always
paints.

**Accepted:** the editor and the version-history diff disagree about what the
document shows, because collapse is view state.

## A block id has one mint (`newBlockId`)

**Why ids stay opaque.** Rows with bare-uuid ids remain: backfilling them is a
migration (two self-FKs plus every `page_blocks_ext_*` table reference them).
And undo of a delete re-inserts under the ORIGINAL id, so a legacy-shaped id
reaches an INSERT on a live path. Destructuring the shape would break on them.

## A page's structural writes are one ordered stream over one locked forest

**Why B has nothing to preserve between writers.** Two different writers (a
second tab, an MCP writer) have no causal order; A is the complete and correct
answer there. A design fact, not a residual gap.

### A — atomicity (server)

**Why two enforcement halves.** The `PageForestTx` parameter makes an unlocked
write a tsc error; the lint stops importing `_blocks` to route around it.
Neither alone is sufficient.

- **Lazy `ctx.forest()`** lets a delete/purge spanning many pages pay for no
  forest it never reads.
- **Sorted lock order** is the deadlock proof for multi-page writers (a
  cross-page move, a subtree delete spanning sub-pages), not a style choice.
- **`null` as a real scope**: the workspace root has its own live unique index,
  so it cannot be a hole callers fall through.
- **`afterCommit`**: fan-out inside the transaction would stretch the lock and
  await the pool from inside it.
- **Unconditional rank parking**: a write that permutes `(parent_id, rank)`
  among siblings transiently duplicates a pair mid-loop, and the index is
  per-tuple and not deferrable.
- **Authoritative lifecycle rows**: the trash set is closed under descendants
  over the forest as written, under the lock, and flagged before anything is
  placed — so a hook needs no DB round-trip and predicts nothing. Anything an
  `OnDelete` hook needs pre-delete it reads on `tx`.

### The context both runtimes must agree on

**Failure mode:** the client predicts with the context and the server commits
with it; a disagreement makes an op apply differently on each side and never
confirm. The registries differ; the shared derivation cannot.

**Why pass the context, not a set.** A new reducer fact becomes one field
instead of one parameter on each of six signatures — which is how
`textBearingTypes` reached both sides at once. `defaultTextType` is derived the
same way, so the reducer names no block type.

**Why absent ≠ empty for `textBearingTypes`.** The empty-set default that is
right for `anchorTypes` would refuse every merge on the page; a context-free
caller keeps the pre-context behaviour.

### B — order (client)

**Why ordering lives in the primitive's lane.** `optimistic-mutation` is
`data = pendingOps.reduce(apply, serverTruth)`. Ops that don't commute need the
server to apply them in issue order, or truth diverges from the prediction
forever. A per-consumer ref chain only orders each mount against itself.

### A rejected write unwinds its undo entry

**Why.** The entry would bracket a change that never happened. A coalescing
entry gets no id because one rejection must not drop the earlier steps that
merged into it and did land.

## The caret authority (input follows the model, not the DOM)

Design:
[`research/2026-07-31-page-caret-authority.md`](../../../../research/2026-07-31-page-caret-authority.md).

**The race it closes.** A block created by Enter registers its handle in a
passive effect — a separate React scheduler task — while keydowns arrive on the
browser's higher-priority user-interaction source. Every keystroke in between
went to the already-truncated origin: "alpha" Enter "bravo" →
`["alphab","ravo"]`. Nothing bounded that window; typing speed usually just won.

**Why the registry is unreachable from the provider.** With `land()` as the only
way to focus a block, no future caller can reintroduce the gap.

**Why idle stays native.** IME, dictation and autocorrect need a real editing
host.

**Why park on the container instead of defending the origin.** With no editing
host, nothing can enter the origin by construction; `preventDefault` is not
airtight (`insertCompositionText` is not cancelable). Consequence: `beforeinput`
never fires during a flight, hence buffering off `keydown`.

**Why `advanceRows`.** Replay issues structural mutations back-to-back with no
React commit between them; ordering and atomicity are invariants B and A above,
and the local third is `rowsRef`.

**The composition-drop bound is a trade.** Before, those characters composed
into the WRONG block; now they are lost, bounded to the mount gap (typically one
commit). IME is untouched once landed, and entirely while idle.

**Why a landing must always resolve.** A policy that takes the caret and never
reports leaves the authority holding the keyboard. `onLandingLost` exists
because neither bound sees that case: `focusout` only sees focus leave the block
LIST (a steal onto another block, or onto `<body>` with a `null`
`relatedTarget`, is invisible), and `reconcile` only counts commits rendering no
line for a target that IS rendered.

**The four replay rules, each from a shipped bug.**

- **One character per commit.** The block markdown shortcut fires on the `"- "`
  transition and inline autoformat demands exactly-one-char-typed; a coalesced
  `insertText` skipped them, so `"- Bravo bullet"` stayed a paragraph and the
  next Enter inherited `text`. The Yjs cost coalescing would save does not exist
  (the run tracker's 500ms idle window folds a run into one undo entry anyway).
- **`discrete: true`.** With Lexical's microtask commit, the next key read the
  pre-insert state, resolved "empty block", and split with `position: 0`, whose
  `truncateAt(0)` wiped the doc (`["alpha","","charlie"]`).
- **One microtask yield per entry.** The editor defers work by `queueMicrotask`
  (markdown conversion, split's doc-edit capture, inline autoformat); replaying
  a whole buffer in one microtask starves it. Microtasks drain before the next
  input event, so the user cannot overtake the buffer.
- **Default actions for unconsumed keys.** `dispatchCommand` is not a DOM event
  and a synthetic `KeyboardEvent` is untrusted, so five buffered ArrowLefts did
  nothing and the following Enter split at the end instead of mid-word. Up/Down
  have no model equivalent; dropping one loses a caret position, never content.

**Why only a not-yet-existing block is claimed.** For a block with no mounted
handle the caret never left the origin; claiming for a landing that may never
come would strand the user's typing.

**Why a handle without `replayInput` aborts loudly** — rather than eating the
keystrokes.

**Why the bound reads the rendered line set.**

- Not `serverIds`: under never-revert a split's block renders long before any
  push confirms it, so every normal split would abort.
- Not "the row exists": a row under a collapsed ancestor mounts no editor, so
  the landing never happens and the keyboard hangs undiagnosed.

**Why two guardrails.** The jsdom test is the only place the long window is
deterministic, but its fake handles have no editor state: the `discrete` defect
passed there and was caught only by the e2e in a real browser.

## The caret does not stop at the editor's edge (`CaretSurface`)

**Why one contract.** It is Notion's model: the caret crosses the title/body
seam the way it crosses two blocks. Because `navigate()` calls `landCaret` the
same way for blocks and chrome, a one-line surface merely omits
`focusAtColumn` — no special case anywhere.

**Why the terminal landing is the block's own far edge.** ArrowDown on the last
line lands at the end of the text, the way a textarea and an `<input>` behave.

**Why `focus()` must not place.** `Tab` / `Shift+Tab` executors call
`focusBlock`; a placing `focus()` turns every re-focus into a caret-to-start
keystroke. That is also why the empty-background click goes through
`focusBlockBoundary` in all three branches.

**Why the resolver stays boundary-blind.** "Backspace goes back to the title"
needed no new intent, op or resolver branch — whether a surface waits on the
other side is the executor's business.

## A void block has no caret to see (`web/components/void-caret.tsx`)

**The failure.** `navigate()` walks registered handles, so a void block with
none is skipped by the arrow keys while a click can still focus it — the caret
jumps over a block the user can plainly see. Eight types (image, video, audio,
file, embed, bookmark, place, page-link) were in that state at once, and nothing
could tell, because forgetting to declare looked exactly like having nothing to
declare. So the fix is not "call the hook eight more times".

### Two answers, and no way to give none

- **No "nowhere" value**: that is the state the eight types were in. A type with
  no registration (`unknown`) falls into `"editor"`, the fail-safe direction.
- **`"renderer"` exists** because only the block knows what holds the caret —
  e.g. `Row` re-synthesizes its inner control the moment the row grows actions.
- **Anchor `caret: never` needs no check**: `defineContainerBlock`'s return type
  states `anchor: true` as a certainty, while the handle's own `anchor?: true`
  cannot be narrowed by hand — anchorhood is provable to the type.

### What the caret on a media block MEANS

- **Focus reports upward via `focusin`**, so DOM focus and the editor's model
  cannot come apart; inner controls need no hand-reporting props.
- **One-press delete.** A filled image is one object, not content to clear and
  then a block to delete. Clearing is the Remove/Replace button: two
  affordances, two meanings. Landing above makes a Backspace from the block
  below read as one continuous motion.
- **`useBlockActivate` rather than a registration field**: the answer depends on
  state a registration cannot see (a hidden `<input>`'s ref, which arm
  rendered). It is a no-op outside a host because shared components
  (`AttachmentUpload`) should not need to know their surface.
- **Escape**: the host has no Lexical and its Backspace deletes, so without it
  there is no keyboard route into a selection containing a media block.
- **`defaultText`** keeps the editor naming no block type (no editor↔text
  cycle).

### Escapes are unconditional; meanings are the host's own

**Failure mode of a single origin guard** (`e.target === e.currentTarget`):
once focus is on an inner control — the upload dropzone, a URL field, a link —
↑/↓ reach nothing and the user cannot leave the block by keyboard.

**Why `useCaretEscape` is a separate hook.** Textarea types must NOT take it
(their arrows move through their source). "Don't spread that field" is a
discipline; "don't call that hook" is a spelling.

### Focus: three rules, three different questions

- **No "already focused?" guard** in `useVoidCaret`: `.focus()` on the focused
  element fires nothing, so the guard bought nothing, and it is unspellable
  against a capability anyway.
- **Rule 1 (focus inside me)**: clicking "Remove image" focuses the button,
  which bubbles and makes the block current; without the decline the pull
  would yank focus off the button just clicked. An auto-opening `page-link`
  picker would race this and lose — hence `useBlockActivate`.
- **Rule 2 (focus went nowhere)**: "Remove image" clears the payload, the
  focused button unmounts, focus falls to `<body>`. `isFocused` never changed,
  so the model says the caret is here while the keyboard is nowhere. Reclaiming
  from "anywhere outside this row" would steal from a portal — rule 1's blind
  spot by a different road.

### The cue is two conditions that LAYER, not one replacing the other

**The failure.** A cue that wrote `outline-none` unconditionally and drew a ring
on `isFocused` — a different condition — showed nothing at all when a box held
keyboard focus while the model disagreed: the browser indicator was off and the
replacement never fired.

**Why the accent tint.** It is `Row.selected`'s tint, so `sub-page` (a `Row`,
passing `hover="accent"`) and every hosted block say the same thing the same
way; it differs from the selection band by design (the app's two-cue language).

**Why the lint has no path exemption.** The host writes the focus utility
unconditionally and gates only the tint, so its definition site does not trip.
If it ever did, that would be the signal.

### The host adds no padding, and it counts as row background

**Why the host counts as background.** It is full-width, so a press beside a
480px image lands on it; without `data-caret-host` the whole margin of every
media row would stop being background and no marquee could start there.

**Accepted:** a margin click focuses a media block rather than selecting it,
and its edge is ignored (a void block is one position). Selecting it is one
Escape away.

**Why no `onLanded` plumbing on void blocks.** `landFlight`'s void arm keys on
the absence of `replayInput`, so a landing resolves with nothing on the block's
side.

### What a media block still cannot do: carry a caption

**Failure mode of a `caption` string:** the type would be routed to
`BlockTextRenderer` and start absorbing the paragraph above it via the merge
ladders. A child text block also gets the real caret, marks, links, collab and
undo.

## Caret geometry is stated in LINE BOXES (`internal/caret-geometry.ts`)

These rules look redundant but are not:

- **`null` never degrades to "on both edges".** `onTopLine/onBottomLine = true`
  would claim the caret is on the top and bottom line of a multi-line block at
  once.
- **Borrowing the child at the anchor offset** works because that child (the
  `<br>` forming the empty line, the chip the caret stands before) is always on
  the caret's own line.
- **Walking leaves inward**: an unmeasurable trailing leaf hands off to the leaf
  before it; climbing to the parent returns a box spanning every line.
- **Translating the hit-test offset**: element offset 0 would land every hit on
  the block's first line. An element-typed point on a decorator is a caret the
  browser cannot paint, hence landing beside it.
- **The cue shares `caretLineRect`** so the chip and the arrow-key logic answer
  "where is the caret" with the same read; the borrowing branches keep the chip
  on the caret's line on an empty soft line and beside an inline chip.
- Ranges this module *constructs* (`nodeLineRect`) involve no document
  selection, so they do not go through `selectionRange()`.

## A mark boundary is a caret position (the virtual delimiter)

**The bug it fixes.** Marks are bits on a `TextNode`, so at a boundary the caret
is one DOM point with two meanings. A block ending in a marked run trapped the
caret: `offset === getTextContentSize()` was the last position that existed, and
plain text could never be typed after it. This is not `decorator-nav`'s bug (a
position that exists but isn't painted) — the position did not exist. Mid-block
was broken too: typing at `` `zz`|abc `` produced a `code`-marked character in a
run the user was typing outside of.

**Why `virtualStop()` returns direction and marks together.** They are one fact:
which of the two states the caret is standing in. Splitting them lets them
disagree.

**Why a block edge is an empty unmarked neighbour.** That single modelling
choice makes block start, block end and mid-block one code path.

**Why the direction is derived from the live anchor.** The design originally
predicted that `` `zz`|plain `` would need no stop. That was wrong: Lexical's
`resolveSelectionPointOnBoundary` rewrites a collapsed point at `offset === 0`
whose previous sibling is a `TextNode` to that sibling's end, on every
DOM→model resolution. So every boundary, mid-block included, gets a stop — one
extra press each, a deliberate trade for consistency. Because the direction asks
the anchor instead of predicting the resolution, the falsified assumption cost
one test expectation, not a redesign. The bias is a version-pinned library
invariant, not a browser quirk that could flip (citation chain in
`internal/mark-depth.ts`).

**Why `left ∩ right` is not the stop.** It coincides with the real answer
whenever the stop's side is a subset of `natural`'s (every block edge, and the
`` `zz`|plain `` seam), so it looks right and tests green. At `` a|`zz` `` it
computes `{}`, sees `natural` already carrying `{}`, and synthesizes no stop:
you can append to a code span but never prepend into one.

**Why deletion is split by side.** A mark lives on exactly one side; a
single-direction walk from the anchor no-ops on the other's — at `` a|`zz` ``
a Backspace consumed for no effect.

**Why virtual positions, not real zero-width seam nodes.**

- **Not CRDT convergence** — that argument is false. Concurrent inserts are
  ordered, not merged, so two seams can appear; but a dedup rule over converged
  state is a pure function both peers compute identically, and Yjs deletes are
  idempotent. It converges in one round.
- **The browser text layer**: a caret-addressable character breaks
  find-in-page across it, segments spellcheck and double-click word selection,
  and pollutes the single-line `Cmd+C` that `decideTransfer`'s `{kind:"inline"}`
  arm deliberately hands to the browser.
- **The server offset basis**: `$spliceRunsInto` splices a block's `Y.Doc` from
  seam-free runs, so every agent write would delete every seam and every client
  re-mint them.
- **A Lexical-only seam excluded from Yjs is not available either**:
  `CollabElementNode.syncChildrenFromYjs` removes every Lexical child with no
  collab twin on every remote sync, and `SKIP_COLLAB_TAG` is never read by
  `@lexical/yjs`.

### Every arrival is an announced crossing

**Why a Lexical command, not a registry.** A listener runs inline inside the
announcer's own update, so the observer reads the pending selection the crossing
just produced — no `editor.update()` of its own.

**Why a channel at all.** Adding a virtual-position kind is one observer and
adding a mover is one call: `movers + kinds` instead of `movers × kinds`. Only
the direction travels (never a mark set), so "which state does an arrival land
on" has exactly one implementation, reading the live anchor after placement.
`CaretLandOptions.crossing` is the surface-level spelling because a
`CaretSurface` has no Lexical editor.

**Why never inferred.** A transition-derived rule cannot tell a one-character
click from a one-character arrow step, and `$placeCaretAtLinearOffset`'s merge
landing looks like a unit step too — it would arm the `escaped` gate for all
three.

### Depth is STORED, never derived from `selection.format`

**The three aliasing mechanisms, concretely.**

1. **`FormatShortcutsPlugin`**: every row of its table fires on a collapsed
   caret, and Lexical's collapsed `formatText` is a pure selection toggle — Cmd+E
   at the end of a `` `xxxx` `` run yields `format = N \ {code}`, bit-identical
   to depth 1.
2. **`applyInlineFormat`** restores `preFormat` onto the post-transform caret, so
   every successful autoformat lands at `format = 0` on a marked node — the most
   common path in the editor.
3. **Programmatic landings**: `TextNode.select()` leaves `format` untouched,
   `$placeCaretAtLinearOffset` resolves a boundary to the end of the earlier
   leaf, and `appendRunsAtJoin` focuses at the end of a possibly-bold run.

**Failure mode:** the user's next Backspace strips formatting from a whole span
instead of deleting a character — an invisible, destructive edit. The derived
version is tempting because it looks stateless.

**Why `selection.format` cannot be the encoding.** Lexical's format-divergence
carry is a ~200 ms window keyed on `(anchorKey, offset)`, not durable state.

### The `escaped` gate is the safety property

**Why the rung sits above `atStart`.** The caret is at a run's *end*, so
`atStart` is false and the old guard would pass through.

**Why the e2e settles before typing.** Typing inside Lexical's 200 ms window
gives the same rows with no feature at all, so an unsettled test is vacuous.

**Why the unmark lives in `inline-format-surgery.ts`.** That file already owns
the leaf walks, the `hasFormat`-guarded `toggleFormat` idiom (runs round-trip
correct by construction) and the defer-then-re-verify contract a command
listener needs; a third near-identical surgery module would duplicate them.

### `MARK_ORDER` is a storage sort key, NOT a nesting order

**Why no exit order.** The caret never stops between two delimiters, so exit
order is unobservable and nothing can drift. Had it been observable it would be
`wrappersOf` reversed — `code, strikethrough, italic, bold, underline` —
deliberately not reverse `MARK_ORDER`.

### The one door not taken: marks as inline `ElementNode`s

**What it would buy.** `resolveSelectionPointOnBoundary`'s inline-element branch
is gated on `!isCollapsed`, so with marks as elements `(rightLeaf, 0)` survives:
both boundary states become stable Lexical addresses, and `mark-depth.ts` and
`mark-arrival.ts` both go. Convergence is solved (an `ElementNode` maps to a
nested `Y.XmlText`, as `LinkNode` proves).

**Why rejected.**

- **No pending-mark channel for elements.** Lexical's only one is the
  `RangeSelection.format` bitfield, so Cmd+B-then-type, the collapsed toolbar
  state and "which side" all need a new side store — trading the mark store for
  a pending-mark store.
- **Nesting order becomes normative and observable**, and remote applies commit
  with `skipTransforms: true`, so a normalizing transform would not run for them.
- **A hard CRDT cutover**: every `page_block_docs` blob encodes `__format`.
  Roughly two months of work.

ProseMirror and Slate keep marks as set-valued text properties for the first
reason.

### Known bounds

**Why the cue shows at a boundary even when both sides agree.** The boundary arm
is what makes the two states distinguishable — `` `zz|` `` reads `code` and
`` `zz`| `` reads `plain`, at one pixel and one offset. "The sides agree, so
nothing to say" is the wrong test at exactly the position the feature
disambiguates. Its cost: typing inside a marked run at a block edge keeps a chip
on screen.

**Why the cue reads `selection.format`.** It says what a key will type with. A
chip after Cmd+E or an autoformat landing is the point, not a false positive. It
says nothing about Backspace, so a step that changes neither arm stays
invisible (after `` `zz` `` autoformats, the chip reads `plain` before and after
ArrowRight; ArrowLeft back inside reads `code`).

**Why the code chip cannot carry the cue.**

- Both states are the same DOM position, so the browser paints the caret at one
  x either way.
- Restyling the span needs a class on a node Lexical owns — a content write,
  rejected for the same reasons as real seams.
- A fake caret (`caret-color: transparent` plus a drawn bar) leaves no visible
  caret on a missed state change, and fights IME, forced-colors mode and blink.

**Why the second component is not restorable.** It lives outside the document,
so there is no address to restore it to; undo, reload and remote edits all
degrade to depth 0, the safe side.

**Grapheme clusters.** A seam right after an emoji or a combining mark places the
caret mid-surrogate.

**`link` needs nothing** because Lexical already moves a collapsed caret out of
an inline parent whose `canInsertTextAfter()` is false.

**Why a span across a soft break stays two spans.** `walkNode` emits a line
break (and a decorator) as an unmarked run, so the strip walk stops there and
the caret model cannot drift from the persisted one.

**Why the mark model is not in `primitives/text-editor`.** That primitive mounts
`PlainTextPlugin` with no marks. The crossing channel is a primitive precisely
because a mover must announce without knowing who observes.

## Visible-line invariants (Enter / Backspace / Delete)

### Split adoption

**Why the head keeps `expanded: true`** with zero children afterwards: harmless
(no chevron without children), and pinned as a decision, not an oversight.

**Why adoption is derived, never a flag on the op.** Ops apply against the
CURRENT forest — the overlay replays onto a refreshed base, the server applies
against its own load — so a flag frozen at intent time could contradict the
forest by the time it applies (e.g. a racing collapse).

**Why the round-trip test compares structure.** Merge mints fresh ranks on
every adoption, so comparing rank strings fails even on a correct round-trip.

### Enter at the START of a non-empty block preserves the origin's identity

**Why.** Every block-id-keyed thing — the content-doc registry, its owner and
run tracker, undo focus routing — stays stable when the origin's id never
changes. Notion's model. Reference:
[`research/2026-07-22-page-enter-at-start-identity-preservation.md`](../../../../research/2026-07-22-page-enter-at-start-identity-preservation.md).

### The keystroke ladders

**Why Enter over a selection replaces it.** A selection is text being replaced,
not an empty line to escape, so the empty-Enter ladder must not run. Splitting
at the selection's anchor and deleting nothing is the failure mode.

**Why Backspace and empty-Enter order their rungs oppositely.** Backspace strips
what is visually nearest the caret (the marker sits right there); empty-Enter
escapes nesting outward (the type is the outer layer).

**Why only EXCESS indentation outranks the line break** (Notion's model).
Indentation a block shares with the visible line below is not standing between
the caret and the break above; peeling it would misalign the block from its
surroundings and leave the break still there. A block level with the line below
merges in one press; a deeper block peels only the excess first. With nothing
below, everything is excess, which is the plain ladder.

**Why the structural predicate equals the depth one.** `nextVisibleLine` yields a
child (deeper), else a next sibling (same depth), else an ancestor's follower
(shallower) or nothing — so `!hasExpandedChildren && !hasNextSibling` is exactly
"deeper than the next visible line".

- **The excess outdent adopts nothing**: excess implies no next sibling. This
  avoids the silent re-nesting `unwrap` exists to prevent, which the first
  child of an ordinary parent would otherwise hit.
- **Outdent stays as a fallback below merge**: with no break above (page
  boundary, text-less previous line), deferring outdent would remove the block's
  only escape from nesting.

**Why `readCaretContext` returns `null`.** Every rung gates on
`atStart`/`atEnd`; `offset: 0` with `atStart: false` silently demotes every
structural keystroke to a passthrough. A root-anchored selection is what Lexical
produces when the selection first materializes on a childless root (the normal
state of a freshly split block), and it never re-anchors it.

**Why Delete's ladder is one rung.** Backspace's is long only because the
current block's own marker and indentation sit between the caret and the break
above. To the right of an end-of-line caret nothing does — the next block's
marker and indent come after the break. A longer ladder would take three presses
to remove one line break, which no editor does.

**Why Delete needs no new op.** It is Backspace's merge from the opposite block,
which holds only because `prevVisibleLine(nextVisibleLine(X)) === X`; hence
`prevVisibleLine`'s upward branch (a first child's previous line is its parent).
The caret sits at the join and does not move. The ~1s-lagged `runsOfNode`
fallback is only for text-less blocks, where empty runs are the true answer
rather than an absorbed miss.

### The `dataOnSplit` seam

- **Method syntax**: a property-typed function is contravariant in `data` and
  breaks `BlockHandle<unknown>` registry assignability.
- **Resolved in the resolver**: only it sees block handles; the pure reducer
  cannot, so the result rides on the op.
- **`tailType === node.type` guard**: a heading→text end-split must not run the
  heading's transform against the text schema.

### An op's target set is what it WRITES, not only what it names

**Why measure writes.** A split's adopted children, a merge's unnamed target, a
delete's cascade and an unwrap's promotion are written but never named; the
reducer's output reports them for free.

**Why the union, not the diff alone.** The diff is smaller than the named set in
real cases: an end-of-line split rewrites the origin byte-identically, an
Enter-at-start split leaves it untouched, a partially refused indent moves fewer
rows than it names, a `bulkMove` names its whole selection while only roots
move. Dropping the origin from a split's set would let a later patch on that row
stop being blocked. The union is monotone — never less coverage than naming.

**Why the frozen set is safe.** At replay the true write set may be a strict
superset (a racing expand adds adoption, `prevVisibleLine` resolves elsewhere, a
cascade grows). Blocking must be decided before the replay that would measure
it, and `sameTarget(a, b)` sees no base. A symmetric intersection only defers on
an over-match; a subset test would invert the guarantee (a missing id on the
older side makes it pass), which is why the primitive blocks rather than
absorbs.

**It does not weaken the adoption rule**: `targets` is recorded alongside the
op and never read by the reducer.

## The selection highlight belongs to the RUN, not to the row

**Failure mode of a class per row.** N selected blocks read as one region, but N
boxes restate them as N: every internal boundary draws two rounded corners and
two hairlines meeting, so a three-paragraph selection renders as three stacked
cards. A run is one element with no internal edges to draw.

**Why resolved by the editor.** "Is the line above me selected too" is unknowable
from a row alone (like `RailSeat`).

**Why touching bands at a step.** A selected block deeper than the line above
gives a notch in one region, not two boxes. A selected container paints over its
frame span, so the anchor's zero-height row needs no branch.

## The block list is a document, not a listbox

**Why no composite role.** A composite role is a contract about its children (a
`listbox` promises options), and no child role can host rich-text editing. A
`role="listbox" aria-multiselectable` container is worse than no role: it
announces an empty list and flattens the subtree, hiding the headings, lists and
quotes that are the point of a page.

**Why `role="option"` is the trap.** It is the first fix everyone reaches for. An
option's accessible name is its text content, so it collapses the editing host
into a label and drops the editing semantics.

**Why `aria-selected` has nowhere to live.** It is supported only on `option`,
`row`, `gridcell`, `tab`, `treeitem`, `columnheader` and `rowheader`, none of
which may host a `contenteditable`.

**Why no role swap while selecting.** It needs `contentEditable={false}` on the
rows, and the caret authority parks the keyboard on the container waiting for an
editing host the swap has just removed — a deadlock.

**Why the announcement guards.** A marquee drag re-applies the same range on
every pointermove, so an unchanged range must be silent; a clear over nothing is
silent too.

**Why the `sr-only` span is always mounted.** The row's children list must keep
a constant length; `sr-only` is `position: absolute`, so it perturbs no rect that
drag, drop or marquee measure. The flag is a prop because the editor already
recomputes every row on a selection change.

## A selected block always carries its children

**The failure.** Every structural op acts on subtree roots, so a highlight
showing a parent without its children showed something other than what the next
key would do: selecting a parent and its first child, then Backspace, deleted the
unhighlighted second child too.

**Why in `applyRange`.** It is the one funnel every range change passes through
(Escape in a block, click, Shift+Arrow, marquee, pointer landings). The reducer
then stores the closed range and no consumer re-derives it; if a second closure
is ever needed, the funnel moved.

**Why the range stays contiguous.** In a DFS flatten a block's descendants are
the rows directly after it while depth stays greater, so the closure only pushes
the bottom end down. Selecting a child does not select its parent: acting on the
child leaves the parent where it is.

**Why the anchor may move.** It is the one place the anchor moves under the user,
and it is honest — the anchor is an end of the selection, and the selection now
ends lower.

**Why it reads the visible flatten.** What a selection may cover is what the
user can see; a collapsed container's hidden children still travel with their
root because the op acts on the subtree.

**Why a plain Arrow leaves from the edge.** Stepping from the head would walk a
plain ArrowDown back into a range drawn upward, and into a parent's children.

## Block-selection mode: the container handles only keys it originated

**Why `e.target`, not `activeElement`.** React delegates `onKeyDown` from the
root, so a key a block already consumed still bubbles to the container.
`enterSelectionMode` moves focus to the container mid-dispatch, and the
synchronous discrete `focusin` makes React flush and re-render before the
keydown arrives — an `activeElement` check then claims it and undoes what the
block just did (a TOCTOU). `e.target` is fixed at dispatch. Reference:
[`research/2026-07-10-page-escape-block-selection.md`](../../../../research/2026-07-10-page-escape-block-selection.md).

**Why the clipboard handlers keep `activeElement`.** "Does the container own the
clipboard?" is a genuine `activeElement` question — a `copy` event's target
follows the DOM selection, not focus. The `defaultPrevented` decline exists
because a spliced caret paste can claim the caret and focus the container
mid-dispatch, so the same forest was pasted a second time as whole blocks.

**Why release the caret rather than tag reconciles.** Focusing the container
does not move the DOM selection, and Lexical re-derives each commit's pending
selection from it; an untagged reconcile then calls `rootElement.focus()` and
destroys the selection with no user input. Tagging is impossible:
`@lexical/yjs`'s `$ensureEditorNotEmpty` commits untagged outside its own
`COLLABORATION_TAG` block and exposes no seam. Dropping the DOM selection is
robust to any async refocus, not one trigger. Reference:
[`research/2026-07-17-page-block-selection-focus-steal.md`](../../../../research/2026-07-17-page-block-selection-focus-steal.md).

**Why the selection bar copies explicitly.** The bar renders outside the
container, so with no caret a button-provoked `copy` has neither a selection for
`execCommand("copy")` nor a path to the container's `onCopy`.

**Why the rail never takes the keyboard.** A selection surviving a focus move
onto a button would be highlighted but keyboard-inert. Without `RailButton`,
mousedown on the drag handle cleared the selection before dnd-kit's 4px
activation distance, and every multi-block drag silently degraded to a
single-block `move`. Nothing needs the default: `PointerSensor` activates off
`pointerdown`, the popover opens on `click` and refocuses explicitly, and Tab
still reaches the handle.

**Why a non-selected drag clears explicitly** (Notion's model): with the focus
steal gone, a single-block drag would otherwise leave a stale highlight over
blocks the gesture never touched.

### A text drag becomes an editor-owned span at the first boundary

**Why the editor owns it.** Each block is its own editing host and a native
selection is clamped to the host it started in: dragging out collapses it, and
Cmd+C copies `""`.

**Why Enter over a span is one entry.** Replaying it at the join through the
flight buffer recorded the split as a second entry: one Cmd+Z put the line break
back and left the span deleted.

**Why a composition key starts with the next key.** The container is no editing
host, the same bound as the caret authority's flight.

**Why Shift+Arrow draws a span instead of jumping to blocks.** The native
selection cannot leave its host; jumping straight to whole blocks skipped the
partial-text step. Whole blocks are one Escape away. `CaretContext.focus` is
separate because a range grown to the edge has its focus there while its anchor
is still mid-line.

**Why `SpanMotion` is a capability.** It keeps `use-block-selection` DOM- and
registry-free, hence jsdom-mountable.

**Why `normalizeSpan` widens rather than refuses.** A page row, an anchor, a void
block or an unmounted line cannot end a span; snapping offsets outward off
tokens means a cut never splits a chip. Every consumer then trusts both ends.

**Gesture rules, with their failure modes.**

- **No interception on the way down**: until the pointer leaves the row, native
  intra-block selection is the feature.
- **Anchor before `focusContainer()`**: `releaseCaret` is about to drop the native
  anchor; read after, it is gone.
- **No one-way rule**: it existed because returning to the origin meant
  re-seating a partial caret in a blurred block, the state `releaseCaret`
  prevents. A span inside one block is legal, so nothing is re-seated.
- **`select-none` via `flushSync`**: the pointer is still down, so the browser
  re-seats a range in the origin host on every pointermove the class has not
  reached; through ordinary state it landed a frame late and showed a native
  selection beside the painted span.

**Edge auto-scroll.**

- **Two clocks**: with the pointer parked at the edge, the content moves, not the
  pointer — evaluating only on `pointermove` scrolls and selects nothing new.
  Feeding `track` from the applier makes the hook re-latch off its own callback.
- **Engage only once the gesture is ours**: the trailing `min-h-40` zone sits in
  the bottom edge band on a full page, so engaging on press turns a click there
  into a runaway scroll that arms `dragMovedRef` and swallows `onEmptyClick` —
  click-to-edit at the bottom of a page stops working.
- **Two coordinate spaces**: the marquee is an absolutely-positioned child of the
  content box; subtracting a frozen viewport `y` from a content rect re-read every
  frame drifts the anchor by the pixels scrolled and drops them from `height`.
  Measuring the threshold in `contentY` makes a stationary pointer over a
  scrolling surface count as a drag.
- **`pointercancel` teardown**: missing it would leak a scroller with no pointer
  left to end it.
- **`preventScroll: true`** on the per-move `focusContainer()`: otherwise focus
  fights the scroll every frame.

### A native selection lives in an editing surface, or nowhere

**The failure.** A selection anchored outside every editing host is clamped by
nothing: it runs across the whole document, paints over the block selection the
gesture is building, and copies the rows' `sr-only` "Selected." markers instead
of their text. A drag starting in the left area highlighted the page from far
above the gesture — *sometimes*, depending on which box's padding the press hit.

**Why the surface, not per-gesture cancelling.** Cancelling in `onPointerDown`
must be re-decided in every branch that classifies a press, and the branch that
starts no gesture (content the editor deliberately leaves alone) is exactly the
one that leaked. A press cannot start what the surface does not allow.

**Why `read-only-view` is untouched.** It mounts no editing host, so a selection
across its blocks is ordinary text the user may copy.

### The text span is painted, never native

**Why one colour.** A user must not see where the native selection in the origin
block stops and the painted span starts. A local tint (the bands' `primary/15`)
was nearly invisible on a dark background, hence the theme token. The pixel test
runs with shadows off: the format toolbar's popover shadow darkens the word in
dark mode.

**Why the Custom Highlight API.** It paints across editing hosts with no DOM
mutation (which would fight Lexical/Yjs reconciliation) and no native selection
(which no host can hold). Resolving through the caret's own
`$resolveLinearOffset` makes a painted end and a landed caret one DOM position.

**Why only a span END leaving clears it.** A middle line leaving is harmless —
the op derives the lines between afresh.

**Why one registry, many painters.** `CSS.highlights` is per document, and two
page panes are two editors.

### Deleting a span is ONE op (`deleteSpan`)

**Why one op.** Three ops would let another client observe, and a failure leave,
a half-applied edit.

**Why `runs` is A's whole result.** Only the client knows where in A the span
starts. The middle lines are derived, not a parameter.

**Why a container ancestor is kept.** The span covered its first lines, not the
box; the empty-anchor prune drops it if C was its last line.

**Why the single-block case is synchronous.** The container's handlers run
outside any Lexical update, and the caret landing must queue behind the edit
(unlike `recordDocEdit`'s deferred one).

### A span on the clipboard

**Why live text.** `data.text` trails the doc by ~1s.

**Why `"text"` granularity.** The paste splices into the caret's line (the start
line's tail merges in, Notion's model) instead of landing as whole blocks.

**Why paste over a span uses the transfer door with `inline: true`.** Single-line
text has no Lexical host to land natively in, so it is parsed and spliced too.

**Why two server transactions are fine.** They go in issue order on the page's
one send lane (*B — order*), and each is valid alone. On the zoom root the splice
is a paste below it, and a pasted file is its own upload write, so those are two
entries.

### A row's pure geometry is background

**The failure.** The ~16px strip between a row's decoration edge and its text
was a dead zone: the editor returned early (neither text nor background), so no
marquee could start there and a click did nothing — and the press left to the
browser is where the whole-document selection came from. A quote or callout
box's padding is the same case.

### Selecting every line a container owns IS selecting the container

**Why it is needed.** An anchor's row is zero-height, has no rail and no
Shift+click target, and `rowAtPointer` skips it. Without the closure, drag,
Shift+click and click-and-extend reach every line inside a callout or `/todo`
but never the box: "select the card, copy, paste" pasted the contents with the
frame stripped, and a drag carried the children out of a frame the user thought
they were moving. Only `⌘A` worked, because it selects every id including
anchors.

**Why `isAnchor` is required.** The defect was precisely an anchor-blind
spelling of "the selection's roots". One resolver for every consumer means a
covered container travels as the container everywhere, not only where someone
remembered.

**Why a childless anchor is not promoted.** It has a real one-line box and is
selected by pointing at it.

**Why monotone.** An anchor the range already carries (crossed from outside,
`⌘A`) stays selected; the roots subsume its children by ordinary subtree
semantics.

**Why derived per render, never stored.** The multi-select range stays what the
pointer drew, so extending it is still index arithmetic over `orderedIds`; the
highlight and the clipboard read the same closed set and cannot disagree.

**How it composes with the descendant closure.** That one closes the range
downward and only moves its bottom end; this one closes the set upward. The
range closure runs first, so what reaches here is a plain set of ids.

## The gutter `+` and `/` are one unified menu

**Why Esc keeps the draft line.** `+` then Esc is "new empty line below" rather
than a click that did nothing.

**Why no "Add block" button** (Notion has none). Every creation path already runs
through a real block with a caret (`+`, `/`, Enter, clicking below the last
block). A "pick, then create" popover would need its own `SearchInput`, with no
caret to filter inline.

**Why two undo entries.** The paragraph genuinely existed: undo once returns to a
paragraph, twice removes it.

**Why insert actions get the query-stripped runs.** The strip lands only after
the menu's own update, so nothing else says it yet; this lets an action that
replaces the line carry the user's words over.

**Why `rowTruthOf === "present"`.** The gutter `+` opens the menu on a paragraph
inserted optimistically, and a server op on a row the server lacks 404s.

## Indent / outdent is a set operation

**Why one op over a set.** The optimistic overlay, the undo record and the
notify path all follow for free; Tab in text is the one-element case.

**Why opposite fold directions.**

- **Indent top-down**: a successful indent removes the mover from its sibling
  list, so the next selected sibling's previous sibling is the same new parent,
  and the run lands as consecutive children. The refusal guard makes a leading
  block that cannot indent hold its whole run.
- **Outdent bottom-up**: every selected follower has already left when an
  earlier block moves, so only unselected followers are adopted. Top-down, the
  first block would swallow the rest of the selection as children.

**Why `documentOrder`.** Ranks are only comparable within a parent; neither the
caller's array order nor a global rank sort is meaningful.

**Why `canIndent` runs the same fold.** The affordance can never disagree with
what the key does.

## Undo / redo (one unified stack)

**Why entries are mount-scoped.** The thunks close over the per-`pageId`
optimistic store and its row truth, which die with the editor; replaying one
after unmount would at worst patch into another page's overlay. The entries
themselves are already self-contained data, so making them mount-free is
possible later.

**Why no Lexical `HistoryPlugin`.** A per-block parallel history is a layering
error: the `page_blocks` row tree, not a Lexical document, is the source of
truth. One stack interleaves text and structure chronologically.

**Why the surface routes the keys.** One `useUndoRedoShortcuts()` per tab means
the sidebar and the body cannot race for the same key id.

**Why the block list claims the keys rather than inheriting them.** Otherwise ⌘Z
in the agent prompt beside an open page undoes the prompt AND the page. Focus on
`<body>` (where a structural undo leaves it) still resolves to the surface.

**Why patches re-applied to the current state, not snapshots.** Undoing an old
action never clobbers later unrelated edits. Sealing open typing runs first means
a structural op never records ahead of the run that preceded it. Undo replays
runs-edit `before` then the reverse patch (and redo the opposite) so a doc edit
always runs while its row exists.

**Why one `commitRow` chokepoint.** Forward apply and undo/redo are symmetric by
construction, and a new block type's `editor.update(...)` is recorded with no
extra code.

**Why two patch predicates.**

- The apply-guard must compare `data`: a data-only edit (to-do `checked`,
  callout colour) is real, and a data-blind guard swallowed every one of them in
  memory mode.
- Confirmation must not: `parseBlockData` normalizes `data` and `data.text`
  trails the doc by ~1s, so a snapshot that provably contains the write can
  still differ, and the op would stick in the overlay.

**Why a restore is judged by presence alone.** The server restores the STORED
row and ignores the create's fields (re-ranked after a slot occupant, reparented
to the root, expanded if toggled in between). Comparing fields stuck the op in
the overlay — painting the recorded collapsed toggle over the server's expanded
one — with no later push to rescue it, since the patch itself wrote nothing.
`restoreIds` is derived at the one dispatch chokepoint so no call site can
choose wrongly; a genuine create (`"unseen"`) keeps the full comparison.

**Why post-patch parentage for the cascade.** A row the same patch re-parents out
of the deleted subtree stays live on the server; if `applyPatch` disagreed, the
overlay dropped rows the server kept — redoing an `unwrap` lost every promoted
child.

**Why the undo test asserts the forward change too.** Without it, a mutation that
silently does nothing passes vacuously — which is how the data-blind apply-guard
hid.

**Why `setExpanded` is not recorded.** Collapse is view state; Notion doesn't
undo it either. It stays optimistic, just off the stack.

## Drag and block-selection writes are ops too

**Why positional intent.** `page_blocks` has one `(parent_id, rank)` space that
several live resources project disjointly, so a key minted over the rows one
writer holds collides with siblings it cannot see.

**Why cross-page moves are endpoints, not ops.** The row leaves the source page's
resource entirely, so no per-page overlay could ever confirm it. A cross-page
`bulkMove` reaching a page's lane was left rendered but unsaveable by the op
endpoint's 400 — hence `resolveOpOwnerPage` throws.

**Why `delete` is a set.** One gesture is one op, one undo entry, one
transaction.

**Why the database answers cycles.** A dragged sub-page's content is keyed to
that sub-page, so a page-scoped forest cannot see a destination inside it.

## With nothing selected, the caret's block IS the selection

**The gap it closes.** A `copy` with a collapsed caret reached
`@lexical/rich-text`, which had nothing to copy and did nothing at all. The rule
claims only the case where the native gesture was a silent no-op; a real text
range is still the browser's inline copy, marks and all.

**Why one writer.** Container and caret copies produce byte-identical payloads by
construction, not by two implementations agreeing. It stays out of
`internal/transfer.ts` so that module loads with no Lexical and is
unit-testable.

**Why a cut deletes only after a successful write.** A cut that never reached the
clipboard must not destroy the block. Using `editor.remove()` makes the caret
land where a delete lands, in one undo entry.

**Why the caret's block, not its container.** The keyboard acts on the line you
stand in; copying a whole container is what selecting it as a block is for.

**Known bound:** the row lags the doc by ~1s, so a copy right after a keystroke
carries the pre-keystroke text (shared with duplicate). The e2e's no-settle
phase deliberately asserts the timing; a settle would silently re-test an
earlier phase.

### "Nothing selected" is a question for the DOM, not for Lexical

**The failure, and why it points nowhere near its cause.**

- **One-step selections** (`Shift+Home`, `Shift+End`, `⌘A`, drag, triple-click)
  are the damaging shape: only then does "stale" mean *collapsed*. ⌘C in that
  window copied the whole block, and `BlockForestPastePlugin` landed it as a new
  block below — the user saw their text not arriving inline. ⌘X would have
  deleted the block.
- **Only the first step of a gesture** has that shape; from the second
  Shift+Arrow on, the model is merely one character behind. So it read as "only
  whole-line selections are wrong", and as a PASTE bug — the paste was
  faithfully landing what the copy had written.

**Why disagreement declines.** The worst case of declining is a bare-caret copy
falling back to the native no-op; the worst case of claiming is copying — or
cutting — a block the user never selected.

## A block is ONE paragraph, and a paste cannot make it two

**Why guard at `SELECTION_INSERT_CLIPBOARD_NODES_COMMAND`, not `PASTE_COMMAND`.**
`$insertDataTransferForRichText` dispatches it for every markup flavor and every
gesture reaching it — paste, drop, IME-controlled insertion — so the rule holds
for all of them, not only the ones listed.

**Why `isBlockLevel`.** It is `insertNodes`' own predicate for its
paragraph-splitting branch, so the guard tests exactly what it guards against;
the common all-inline paste keeps Lexical's behaviour. Re-applying the last
run's marks restates what Lexical's unexported `$updateSelectionOnInsert` would
have done.

**Why it is reachable after `decideTransfer`.** That classifier reads
`text/plain`; `text/html` comes from another app and need not agree. A
single-line `text/plain` beside multi-paragraph HTML is ordinary output of real
editors: a lone `<p>hello</p>` merges on its own, but `<p>a</p><p>b</p>` leaves
the root with two paragraphs.

**Why the soft break is lazy.** A leading-edge-only rule fuses
`<p>a</p>tail` into `atail`, and leaves a stray trailing break (a trailing `"\n"`
run, the caret parked on a `<br>`) for the `<p>a</p><p></p>` real editors emit.

**Why three arms.** An empty result and a refusal need different decisions; a
bare array would let them ride together. `empty` must still replace the
selection, which `insertNodes([])` returns too early to do. `not-inline` (a
non-inline decorator) has no inline form, so dropping it would lose content; the
arm makes adding such a decorator a visible behaviour rather than a silent
delete.

**Why the plain-text arm needs the other leg.** That arm calls
`insertParagraph()` per newline and dispatches no command, so no listener can
reach it. The invariant stands on two legs: markup arms guarded here, plain text
with a newline classified away before it gets there.

## The transfer door (one classifier, two gestures)

**Why `readTransferText` falls back to `text/uri-list`.** It mirrors Lexical's
own fallback byte for byte; otherwise a transfer describing a link only as
`text/uri-list` is invisible to the classifier and lands in the native arm
anyway.

**Why the container owns drops.** A drop has a pointer position, and where it
lands is container knowledge. A per-block `DROP_COMMAND` for forest/markdown
would double-handle.

**Why the container can cancel the native insert.** React's root listener runs
in the native `drop` bubble, before the default action; `preventDefault()`
cancels the `insertFromDrop` beforeinput, which is how the plain-text arm was
being reached.

**The cost of types-only dragover.** During a drag `getData()` returns `""`, so
single-line and multi-line text cannot be told apart. A text drag over a
block's own text therefore shows no scrim or insertion line; the drop fires
anyway and is claimed only if it turns out to carry newlines.

**Why a Lexical-marked drag is never claimed.** It means Lexical is MOVING its
own nodes with source-removal semantics (cut-and-paste, not copy), and it rides
along with the selection's own `text/plain`.

**Why `inline` means "no newline".** Text without a line break cannot carry
structure, so the native insert is right for it — and keeping it native keeps
url-paste, token-paste, HTML marks and the paragraph guard working. Because the
splice puts whatever the parse yields AT the point, "one parsed paragraph
mistaken for structure" is no longer a class of bug.

**Why the URL drop calls `stopPropagation()`.** A `text/uri-list` is
CRLF-terminated (RFC 2483), so the most common link-drag payload is literally
multi-line and classifies as markdown at the container: one dropped URL would
insert the link AND mint a block. Only drop needs it — a caret paste never
reaches the container's `onPaste`, which gates on the container holding focus.

**Why the CRLF is not trimmed.** The arm it declines into reads the same raw
text; a trimming classifier would call the URL one line and hand it to the
native insert, which then splits the root on the very terminator. So a
`uri-list`-only drop into text becomes its own block — the safe reading. A real
link drag also carries a terminator-free `text/plain`, which is preferred.

**Why the URL drop keeps the empty-block gate.** A drop into existing text lands
where the browser puts it, not at a caret we hold. It declines on an unhydrated
root because there is nowhere to seat the caret.

## Paste is an op (`{ kind: "paste", forest, afterId, parentId }`)

**Why it is optimistic.** As a blocking request, a 25-block paste took
~560–790ms to first pixel with a ~500ms main-thread freeze; it read as the app
hanging.

**Why ids ride the node.** A parallel positional `ids[]` breaks silently: reorder
a traversal on one side and the two sides insert different blocks, so the op
never confirms.

**Why anchorless paste inserts at the start.** It is the inherited contract, and
reachable only on an empty page.

**Why `OpEffect.create` lists roots only.** The forest lands in one transaction,
so a root's presence implies its descendants'; listing every node would grow
confirmation scans with the paste for no extra power. This is about naming only —
`writtenIds` lists the whole forest for `targets`.

**Why a missing anchor refuses the whole paste.** Guessing another parent would
drop content somewhere the user never asked for.

**Why one `prepareForest`.** Paste and splice mint through it, so the
cut-sub-page rules cannot differ between them.

**Why the e2e stalls the endpoint.** It does not trust latency: with the op
endpoint stalled 4s, blocks must render long before the server could answer.

### A paste lands AT the insertion point (`{ kind: "splice", … }`)

**The failure it fixes.** Pasting as blocks AFTER the caret's block put every
multi-line paste in the wrong place: `The plugin system⏎` into an empty line
left that line empty above a new block; `a⏎b` at `foo|bar` gave `foobar`, `a`,
`b`.

**Why each step.**

- **Head**: only a plain paragraph has an inline form; nested lines become the
  origin's first children so a partial copy's nesting survives.
- **Consume an empty origin**: `# Title⏎body` into an empty line leaves no blank
  line above the title.
- **Body at `splitSlot`**: the one placement rule split and splice share — next
  siblings, or the first children at the end of a line whose children are
  visible (where Enter nests).
- **Tail onto the last line at any depth**: a multi-line partial copy pasted
  mid-line joins at both ends (`zz|zz` + `aa` › `bb` → `zzaa` › `bbzz`). A
  first or last root with children not counting as plain split the caret's line
  around whole blocks instead.

**Why granularity is declared, not inferred.** One copied paragraph and one
pasted line of text parse to the same node. A block copied whole must not be
merged into the caret's text. A pre-envelope bare `BLOCKS_MIME` array decodes as
`"blocks"`, which is true of every one written.

**Why `"blocks"` stays a splice mode rather than routing to `paste`.**
Consuming an empty origin and replacing a selected range belong to the insertion
point, and `paste` has none.

**Why a no-row splice is a doc edit.** An existing block's text is doc-owned, so
no row op may carry it; and `OpEffect.create` then lists only rows really
created (an absorbed head never), so a dispatched splice always creates one.

**Why a missing live owner throws.** A splice only ever comes from a mounted text
surface.

**Why the zoom root pastes as first children.** The root's next siblings are
outside the view, so a splice there would be refused whole.

**Accepted:** a paste fired in the same task as a one-step selection reads the
pre-gesture caret — paste is not in Lexical's DOM-resync allow-list, and
Lexical's own native paste behaves the same.

### Duplicate is copy + paste-in-place (`{ kind: "duplicate", placements }`)

**Why one serializer.** "Duplicate ≡ copy then paste after the source" holds by
construction, not by two mirrored implementations agreeing.

**Why a distinct kind.** A duplicate must not read "Paste blocks" in the
history.

**Why a dead anchor drops only its placement.** Paste refuses whole to avoid
guessing a destination; a placement names its own. All-or-nothing would only
ever fire server-side (the client built the op from rows containing every
anchor), widening the never-confirming set from one clone to all.

**Why no `parentId` on placements.** `translateOpForStore` rewrites `parentId`
only for kinds that have one; adding the field would silently skip anchor
translation in an expanded sub-page.

**Why order is not load-bearing.** Both sides fold the array identically, and a
clone always lands strictly between its source and the source's next sibling.

### A pasted sub-page moves once, and copies after that

**Why a `pageSource` instead of children.** A sub-page's content lives in its own
`page_id` partition, which the editor on screen never loads.

**Why the client decides claim vs copy.** The paste renders optimistically under
the ids it names; the server cannot pick a different identity afterwards.

**Why a claim matters.** It keeps everything keyed on the page id — links,
history, authorship, its content partition. A trashed claim takes back only the
rows under that page (a cut of `[paragraph, page]` leaves the paragraph
trashed).

**Why `OnCopy`.** A plugin keying state by block id brings it along without the
writer naming it (the content doc — which `data.text` may trail — and authorship
conversations). Facts about the SOURCE row (star, TODO binding, agent origin)
are not copied.

**Why rows this write inserted are never re-read as source.** Pasting a copy of a
page into that page must terminate.

## A write names the fields it changes (`BlockPatch`)

**The incident.** A projection flush firing from the unmount cleanup of a
`/callout` conversion restated `type: "text"` over the callout the user had just
picked. Reading render-fresh rows (`liveRowsRef`) narrows that window; scoping
the patch to changed fields removes it.

**Why "an update never creates" by definition.** A missing id is a skip
everywhere, so `isPatchReflected` absorbs it vacuously and the op confirms
rather than replaying forever. Only `creates` bring a row into existence or back.

**Why a restore consumes the whole trash entry and the stored row wins.** Undo of
any delete restores the exact rows (page shell or paragraph alike) with their
surviving content docs, and a re-ranked or reparented root keeps its repair.

**Why one comparator for both predicates.** A patch can never be produced by one
definition of "changed" and judged by another.

**Why validation uses the effective type.** A `data`-only change validates
against the stored type; a `type`-only change re-validates (and re-mints) the
stored blob against the new one.

**Why creates route by their own `pageId`.** That is what makes the
detached-persist path work for a collapsed page; updates resolve through the
union rows, falling back to the cumulative row→page index for rows that left
with a collapse.

### Every block delete is a trash (server)

Reference: `research/2026-09-09-page-data-based-text-undo-entries-v2.md` §3.

**The failure it prevents.** A hard delete cascaded away the row's content doc;
undo re-created the row and re-derived a doc from the ~1s-lagged `data.text`
projection, which under load raced to an empty seed — a to-do came back without
its text.

**Why one anchor entry per gesture.** One gesture is one undo. A page nested under
a deleted non-page root anchors a `pages` entry on that root so it stays findable
in the Trash.

**Why inline vs deferred.** Inline keeps the hot path one transaction; a set with
a page row needs the sub-pages' own locks. Closing under descendants matters
because a descendant left live under a trashed parent is unreachable by any read.

**Why close over the forest as written.** A child the same write re-homes out of a
deleted block (`unwrap`, a merge's adoption, their redo) stays live, while an
orphan a buggy write leaves under a deleted row is still trashed.

**Why trash before placing.** Live unique indexes are partial on
`deleted_at IS NULL`, so a flagged row vacates its `(parent_id, rank)` slot for
a row landing exactly there. **Limit:** the deferred branch trashes after commit
and keeps that collision (no caller hits it).

**Why no "un-trash" bucket in the patch writer.** Clearing flags without
consuming the entry is exactly the half-state the ledger invariant forbids.

**Why `liveBlocks` is a subquery, not a DB view.** The rendered SQL still says
`from "page_blocks"`, which the live-state read-set extractor and the change-feed
match by name. Never spelling the predicate in a reader means it cannot be
forgotten.

**Why the pre-seed keys on `RowTruth`.** Trash keeps the content doc: a client
that pre-seeds a restored row from `data.text` and then merges the surviving doc
duplicates the paragraph.

**Why attachment links stay.** The reconcile writes live owners only, so the
orphan sweep keeps the file until purge cascades the link.

## Text is doc-owned: a row write can never say `text`

**Why `preserveText` carries the key unconditionally.** A conversion keeps the
block's id, hence its doc and text, so the row must neither restate nor drop it;
whether it may survive on the resulting type is `conformRowText`'s question.

### The rule is a BICONDITIONAL, and it lives at the funnel

**Why not at a call site.** Living in `preserveText` alone left both halves
broken for writers that did not call it:

- **text → void.** `projectText`'s flush fires on the text editor's unmount —
  exactly what a conversion to a void type causes — so every `/divider`,
  `/image`, `/place` and *Turn into → Page* posted `text` at a row the server
  knew was void. The conversion itself succeeded, so nothing looked broken, but
  the failed patch is a durable HTTP failure that is never retried and never
  resolves: the save indicator parks on an error whose Retry re-fails, and only
  a reload clears it.
- **void → text.** `emptyRowData()` has no `text` and a void row has no
  projection to carry, so *Turn into → Text* off a divider wrote `{}` against a
  schema requiring `text`. That patch is the conversion's only carrier, so it was
  rejected whole and lost on reload (the overlay renders a rejected write like an
  accepted one).

At the funnel, the text→void projection diffs to nothing and is never sent.

**Why only authored rows.** `after` is every row (over the composite, several
pages). Conforming the rest sweeps unrelated rows into this write's patch under
its undo label — or, for `setExpanded` (`record: false`), into an unrecorded,
unundoable data write.

**Why never `before`.** Undo's update is built from `before`; conforming it (or
conforming inside `diffBlocks`) makes undo of text→void restore a text row
without its text.

**Why no handle means no opinion.** A type can be missing because it was renamed
or removed while its rows live on, because the host mounted a subset of block
plugins, or because the row belongs to another page in the union. Stripping
deletes content. `markdown-apply`'s `survivorData` can collapse the two branches
only because it never strips.

**Why ops are not conformed client-side.** The server runs the same reducer and
400s rather than conforming; a silent client conform would predict a forest the
server refuses, trading a loud 400 for a permanently unconfirmable overlay op.

**Why the strip is a doc edit first.** The row field is downstream of the doc: a
convert carrying stripped text in its row payload left the doc saying
`/callout` while the row said `text: []`, permanently, with what the user saw
depending on whether the projection debounce had fired. It must be `discrete`
because the slash commit runs inside the menu's own `editor.update()`, where a
nested update would commit on a microtask and race the type write's re-render.

**Why wrap-vs-swap lives in `convertRow`.** When the decision sat on
`convertTo`, `convertStrippingText` bypassed it: `/callout` from the slash menu
retyped the origin into a container — losing its text and 400ing on the void
schema — while Turn-into wrapped correctly. A decision only one of two callers
reaches is not shared. The query must leave the doc before the origin becomes
the container's first child.

**Why Backspace-reset strips nothing.** A marker glyph was never text.

## A text block's presentation is styling plus sibling regions

Design:
[`research/2026-07-29-page-text-block-presentation-api.md`](../../../../research/2026-07-29-page-text-block-presentation-api.md).

**Why one component.** React unmounts when the element TYPE at a position
changes, so the element-type chain from the renderer root to
`<LexicalComposer>` must not depend on `block.type`. Props, classNames and
styles may vary freely. (Same principle as a container frame being a backdrop,
not a wrapper.)

**Why regions get no `children`.** A region structurally cannot wrap the line.
The set is closed by geometry (a leaf in a box has two block-axis and two
inline-axis neighbours), so a new type never needs a new position; the price is
that `header` and `end` have no consumer today.

**Why the constraints.**

- **Static `chrome`**: a `chrome(data)` function would mint a fresh component per
  render (resetting the region on every keystroke) and invite a hook inside a
  per-type conditional (crashing on conversion).
- **`ComponentType` regions**: a prebuilt node cannot degrade when `editor` is
  absent, and a region with hooks needs its own scope.
- **One children slot per region**: React pairs unkeyed siblings by
  `fiber.index`, so a length change mis-pairs the leaf cell and remounts
  Lexical.
- **Static `padding`**: `gutterFirstLineCenter` is static per type, so per-row
  vertical padding would seat the rail on a phantom line.
- **Paint-only `boxClassName`**: `overflow-*` would silently change caret scroll
  semantics (Lexical's scroll-into-view and `caret-geometry.ts` resolve against
  the nearest scrollable ancestor).

**Why `BlockTextEditor` is not exported.** It removes the
roll-your-own-text-component affordance outright. The DOM-node-identity round
trip is the only assertion that catches a skeleton element that vanishes.

**Limit:** content aligned to the editable's wrapped line boxes (line numbers,
per-line comment anchors, a diff rail) is out of reach — a sibling column cannot
know line boxes without measuring rects.

## A block type declares its ARIA identity (`semantics`)

Design:
[`research/2026-08-16-page-block-aria-semantics.md`](../../../../research/2026-08-16-page-block-aria-semantics.md).

**Why the leaf cell.** It is the one skeleton element whose content is exactly
the text; everything that would pollute a name-from-content role (marker gutter,
regions, rail, the `sr-only` marker) sits outside it. Attributes only, so the
totality rules don't move and a type change is still a re-style.

**Why on the handle.** A role is neither styling nor a region, and the handle
serves both the editable and the read-only surface. On a void type it is a named
unsatisfiable object rather than an inert field.

**Why the union is closed.**

- **No required context**: the forest is flat, so no element spans a run or
  wraps a subtree; `listitem` needs an owning `list`, `blockquote` would have to
  contain the passage.
- **No presentational children**: `button` / `option` / `tab` / `img` would
  flatten the editing host into a label. `heading` takes its name from its
  contents and leaves them in the tree.

**Why `level` follows the prefix.** Deriving it from a font-size role is how a
big paragraph starts announcing as a heading.

**Rejected carriers.**

- **`<ContentEditable>`**: drops Lexical's `role="textbox"`, and the read-only
  surface has none, needing a second mechanism. The `heading` > `textbox`
  nesting used instead is what `<h2 contenteditable>` produces natively.
- **Real `<h1>`**: a per-type element type, which the fixed skeleton forbids.

**Why the placeholder is hidden.** Otherwise an empty focused heading is named
"Heading 1" by its own placeholder.

**The gap, and why it is not a missing arm.** A list run has no shared DOM
element (introducing one would change a block's DOM parent as it joins or leaves
the run, remounting Lexical), and a quote/callout decoration is an inert
backdrop containing nothing. The answer is `aria-owns` from a zero-height
`role="list"` / `role="blockquote"` element per run, grid-placed like
`frameSpans` — with real a11y-tree re-parenting risk.

## Per-block CRDT text (unconditional)

**Why Yjs merges.** Remote and echoed changes apply as a merge, never a
serialized-string rebuild. Structure stays relational: `page_blocks` rows remain
the tree, and existing pages need no migration (a block with no doc lazy-seeds
from `data.text`).

**Why one transport seam.** A future delta-WS transport swaps in behind
`use-collab-block-doc.ts` and nothing else changes. Hydrating the live doc only
from the server's `doc-init` response closes the duplicate-seed hazard.

#### One owner per block, one session per binding

**Why `end()` defers twice.**

- **One macrotask**: Lexical guards `providerFactory` and `createBinding` behind
  refs, so StrictMode's simulated remount never re-calls either and keeps the
  very replica it holds; `retain()` cancels the pending end.
- **Onto the binding's `disconnect()`**: recovery racing an unmount must not
  destroy a replica a live binding still relays through.
- **Replica first, owner second**: the replica's disconnect eagerly flushes the
  last bytes, so the owner's `readyForTeardown` sees them.

**Why one registry per transport.** The same block id open under two transports
(a demo scope and the page) must be two owners, each seeding, flushing and
resuming against its own server.

**Why nothing releases by id.** A stale hold could otherwise decrement the owner
that replaced its own.

**Why suppression is a scope.** With `untracked(edit)` the only way to raise it,
"who raised it" has exactly one answer.

#### A session PROVES its hydration, and the proof gates the write path

**Why monotonic and per session.** A later re-assert (the confirming doc-init, a
second push, a StrictMode re-`connect()`) cannot re-open a gate a proof already
closed. Recovery is a new session.

**Why locally authoritative sessions skip the proof.** Their content is this
client's own deterministic seed, applied after attach; no remote answer can be
missing. Waiting would cost a freshly split block a full round trip.

**Why the `sync`-with-nothing exit.** Yjs emits no event for an apply that
integrates nothing, so no commit is ever scheduled and every genuinely empty
block would wait forever.

**Why the check cannot be synchronous.** `syncYjsChangesToLexical` commits
without `discrete` and `$commitPendingUpdates` is micro-tasked, while
`doc.on('update')` fires at the tail of the same `applyUpdate`. Inside our
handlers the editor is one microtask stale, so a same-turn comparison calls
every keystroke a blind binding. The tag also excludes Lexical's untagged
initial commit and `$ensureEditorNotEmpty`'s follow-up. `editor.read()` from a
Yjs handler re-enters `syncLexicalUpdateToYjs` inside the doc's own transaction
cleanup. The mount probe may confirm but never conclude: a pending commit looks
exactly like a blind one.

**Why the session's replica, not the canonical doc.** The canonical would import
another binding's concurrency into this verdict.

**Why the gate is on writes, not editing.** `contentEditable={false}` makes the
landing's `root.focus()` a no-op while `reconcile()` sees the target rendered,
so the flight never ends and the keyboard is held. The replica is empty at
attach, so typing into it is a legitimate concurrent edit that merges. `stalled`
keeps the gate open — a failure must not hold the user's bytes hostage — and
`end()` releases it, so a held queue is deferred, never dropped.

**Why no placeholder for an empty row.** Otherwise most of a fresh page becomes a
loading screen. `primitives/loading`'s ~120 ms delay means a prompt doc unmounts
the skeleton before it paints.

#### A restored row binds to its surviving doc (`RowTruth`)

**The failure.** Inferring "no stored doc" from "row not confirmed" holds only
while a delete hard-deletes the doc. With trash, an undo-recreated row is
unconfirmed AND has a doc; a seed pre-applied for it lands as a second
paragraph when the doc merges.

**Why `mayHaveStoredDoc` is readonly.** It records what this client had observed
when the owner was minted, and the pre-seed it licenses happens once. The
positive-`null` pre-apply lets a restored never-opened block render after one
round trip, and the later doc-init carries the same bytes, so its echo is a
no-op.

**Rejected alternatives.**

- **A per-call-site `restore` flag**: a second spelling, missing the
  redo-of-split-undo and paste routes.
- **Strict-null everywhere**: the instant split path would render an empty root
  for a round trip.

**The residual.** `everServerIds` sees only pushes React rendered; reaching it
needs a create→delete→undo faster than one commit.

**Why a flush racing a delete succeeding is fine.** It lands in the trashed doc,
which is what undo restores.

### Projection + content-doc-aware split/merge

**Why the projection reads the owner.** An editor is a view that can silently
fall behind (`@lexical/yjs` has no read-the-doc operation), and empty runs are
indistinguishable from a legitimately empty block. The `DocSourcedRuns` brand
makes persisting a non-doc value a tsc error. Memoizing on a content generation
lets a structural entry pinning a deleted row's text and a projection flush on
the same generation share one headless read.

**Why not a raw `toDelta()` walk.** It would re-derive marks from
`CollabTextNode` property sync, link nesting from embedded `XmlText`, and
decorator tokens from node instances that `ext.serializeNode(node)` needs.
Counting can walk raw; producing runs cannot.

**Why structural ops read the view.** Split, merge and `readRuns` want what is on
screen now, including uncommitted keystrokes (`mergeNext` cannot wait the ~1s
projection).

**Why flush-then-release in one cleanup.** The final flush reads the canonical
doc, so it must run while the hold still holds the entry; splitting it across
hooks inherits ordering from hook-declaration order.

**Why split truncates through Lexical.** The collab binding then syncs the
deletion into the doc with marks and tokens intact.

**Why the projection gates on render-fresh rows.** A deleted block's unmount
flush fires before the effect refreshing `rowsRef`, so an ungated flush would
resurrect the just-deleted row.

**Why an unmounted merge target appends first.** A failed append then leaves
both blocks intact.

**Why "Saved" comes from the doc-update queue.** The cloud says "Saved" only once
every dirty block's bytes are server-acked; `syncing` starts at the keystroke,
not when the 300 ms debounce expires. The snapshot is memoized and frozen so a
`useSyncExternalStore` consumer cannot loop.

**Why offline is not an error.** A network rejection re-queues and retries
push-based, so nothing is at risk. `blockGone` is idle because those bytes were
deliberately dropped (their content moved with the merge). The projection is not
reported here: it goes through the optimistic pipeline, which reports itself.

**Why a 409 re-creates from the full doc, never the seed.** The `data.text` seed
would duplicate content the doc already holds. Arbitrating through a doc-init
probe means a 409 can never silently stop a live block from saving.

### CRDT text on the ONE unified undo stack

**Why every entry is data.** A text entry that popped the block's per-doc undo
manager was guarded by "is this owner still live", so it became a silent no-op
once the doc was destroyed — a deleted to-do came back from Cmd+Z without its
text. With data entries, a genuine replay failure throws and reaches Reports.

**Why typing runs record with no `coalesceKey`.** The tracker already grouped
the keystrokes; app-level coalescing would merge two runs into one entry whose
bracket no longer matches what one Cmd+Z reverts.

**Why the origin rule is stated, not learned.** Exactly three writers may touch
an owner's doc (transport, replay, relay), so classifying origins never guesses.

**Why `untracked` closes the open run first.** Without the scope, split's
truncation, merge's append and `recordDocEdit` each open a run and double-record
on top of the structural entry: one Cmd+Z restored the origin's full text while
the split's tail still existed. A nested `editor.update` from a command handler
is enqueued past the scope, hence the one-microtask defer.

**Why a re-created row waits for confirmation before replay.** Never `doc-init`
a row the server may not have. The stored write takes runs as a function of the
authoritative current runs, so an unmounted merge appends onto what the server
holds, never a lagged row.

**Why removed rows' text is pinned to the doc.** A restored row's `data.text` is
then doc-exact — what history, search and backlinks read, and the seed of a
block whose doc did not survive a purge. A doc still waiting on its subscription
is excluded: its emptiness is not-known-yet.

**The absolute-vs-CRDT trade.** A data entry is absolute ("make this block read
these runs"); a CRDT undo manager is relative. Under single-writer LIFO they
agree; they part only when a second writer edits between record and replay.
Apply-and-report: the user asked for their undo, clobbering the other writer is
the residual, and the report keeps it measurably rare. A remote apply inside an
open run aborts it — one lost undo step at a genuinely concurrent moment, never
an entry carrying remote text as if the user typed it.

**Why the replay caret is derived.** Reading it off the live selection when the
run closed fails for deletion runs (the caret is at the cut, the previous run's
end wherever the user last typed): undo landed at either end of the restored
text depending on history. `changedSpanEnd` puts it after the restored text.

**Why inverse pairs wait rather than absorb.** An undo then redo before the
undo's confirming push leaves the undo unable to ever confirm — every later
snapshot confirms the redo. Making the redo wait (block-id-set intersection)
blocks the pair while an unrelated block's confirmation never touches it; both
replay meanwhile, so the render is right throughout.

**Why only causal exits.** A same-target cascade dropping an older op on a newer
op's evidence is a non-causal exit, and it cost a user a visibly disappearing
block. With no miss-limit eviction
([`research/2026-07-11-global-never-revert-optimistic-edits.md`](../../../../research/2026-07-11-global-never-revert-optimistic-edits.md)),
a non-converging op stays rendered and reports, instead of un-splitting the
user's block.

### Inline markdown autoformat is ONE data entry

**Why `recordDocEdit`.** The run tracker's 500 ms window would fold the transform
into the typing run, and one Cmd+Z would eat `**x**` whole.

**Why defer inside `recordDocEdit`, and why throw.** An update listener runs with
`editor._updating === true`, so an `editor.update()` there is enqueued past the
`untracked` scope: formatting applies, but the undo boundary silently doesn't
exist. Returning `false` would be indistinguishable from a benign drift-abort.

**Why the tag guard makes undo reachable.** A replay re-inserts the delimiters
and `@lexical/yjs` renders it as a `collaboration` change; unguarded, the
listener re-formats instantly and Cmd+Z looks broken. The
exactly-one-char-typed rule is stricter than `@lexical/markdown`, which admits a
decreasing offset and so auto-formats on Backspace.

**Why single-`TextNode` scope plus `isSimpleText()`.** `splitText` on a segmented
node or subclass slices characters that carry semantics, and the scope makes
decorator tokens unreachable by any offset. Cost: `**see [[page]] here**` doesn't
auto-bold (Cmd+B still does).

**Why node-level, `hasFormat`-guarded marks.** It is byte-identical to
`runs-lexical.ts`, so the round-trip is correct by construction; the guard is why
`` `code` `` inside bold adds code rather than clearing bold.
`FORMAT_TEXT_COMMAND` pulls in other listeners; `RangeSelection.formatText` on a
fresh selection (`format === 0`) makes toggle-vs-set implicit over a partly
formatted range.

**Why a closed table, not a slot.** Block types are an open set, but `Mark` is a
closed persisted enum. Pinning the marks as `MARK_ORDER` minus `underline` makes
a new mark fail the suite until someone decides its syntax. It lives in `core/`
because the clipboard converter reads it too.

### The same table, read left-to-right

**Why `protectedSpans` is required.** Decorator tokens are plain substrings of
`TextRun.text` and `\(latex\)` is full of `_` and `*`; an optional parameter is
one a caller silently forgets. Both runtimes contribute the same `core/` regex,
so they cannot drift.

**Why `markdownSpan` is separate from `pattern`.** Masking is not free: a masked
span becomes a run with no marks, so over-protecting silently deletes marks. A
"registered token gets masked" rule made an attempt id in backticks (`` `att-…` ``) pasted as
markdown parse with no `code` mark — an id written as documentation came back as
a live chip. There is no safe default (unprotected LaTeX is corrupted; an
over-protected bare id loses its marks), so only the family that owns the bytes
can say.

**Why hoist boundary whitespace.** It mirrors what the user can type, making
`parse ∘ serialize` an identity rather than merely convergent.

**Why `color` and `underline` are tags.** Colour is a run attribute, not a mark,
and underline has no delimiter.

**Why the shortcut plugin's guard matters.** It stops our output
(`~~- foo~~` → `- foo`) tripping a block conversion, and stops a remote edit or
Cmd+Z converting a block unprompted.

**Why `$$` queries are not guarded via `caret-trigger`.** Candidacy is published
even for a dismissed trigger, so one literal `[[` in a line would silently
disable autoformat for the rest of the node.

### The hydration guard (a view may not overwrite what it disagrees with)

**Why both arms compare against zero.** The doc-side and editor-side length walks
agree with each other but with no character count, so only zero is basis-free.
The starved-doc arm reads the row because a starved doc receives no updates to
trigger on.

**Why `isSynced` gates the second arm.** Without it the arm was timing the
network: it waited 5 s from mount while `sub:page-block-doc` reached 907 s under
load, so healthy cold opens tripped it constantly (hundreds of reports, dozens in
seconds). The window now opens on the sync edge; ~2 s is a grace for the apply
and its commit, not a latency guess.

**Why two recovery verbs.** A fresh empty replica (`rehydrate()`) is the only fix
for a binding that missed its post-attach `observeDeep` set, but it is
destructive (the text leaves the DOM until the re-read lands) and must bump the
plugin `key`, since Lexical builds the binding once per mount behind a ref.
`refetch()` moves nothing on screen. Picking by defect means a residual false
positive costs one request instead of blanking a line.

**Why `everRendered` lives on the owner.** Recovery mints a new session and a
frame move remounts Lexical — exactly what the latch must survive. It is folded
into the one hydration snapshot because a second store would tear.

**Why only a detector.** The projection reads the doc, so it cannot persist a
blind binding's emptiness; what remains is a recoverable render defect, reported
because a silent self-heal is indistinguishable from a bug that never happened.

### Hardening

**Why doc-init waits for `"present"`.** A split block mounts from the optimistic
overlay before the POST creates its row; an ungated doc-init FK-violates and the
`initStarted` latch wedges the block editable-but-never-synced. Edits in the gap
buffer in the doc and flush after the seed.

**Why deterministic seeds.** Identical runs encode byte-identically, so a
mismatched seed can only duplicate, never corrupt by item-id collision; an
`"unseen"` block can pre-seed at `connect()` instead of sitting empty until the
confirm push (where typing would merge badly with the later seed). Retries must
never post different bytes. Keying the discriminator on confirmation or effect
order duplicated text on reopen and on restore.

**Why `SKIP_DOM_SELECTION_TAG` on the truncation.** It is background surgery on
the block the user is leaving; reconciling its cut-point selection yanks focus
back. `rootStart` because a pre-seeded editor has no prior selection and Lexical
defaults to the end.

**Why queue, never a retry timer.** The `online` event is needed because an idle
WebSocket may not surface a close promptly. Retaining the owner until
`readyForTeardown` makes an unmount during an outage loss-safe. **Limit:**
closing the tab offline loses unflushed edits, like an unflushed autosave.

**Why "an update never creates" matters here.** Otherwise a debounced projection
racing a history restore (or another tab's delete) resurrects the row with
pre-delete text. The patch shape is the guarantee; there is no flag to forget.

**History restore.**

- **Why match by id and hard-delete nothing**: a block created since is trashed,
  so restoring "Before restore" brings it back the same way; deleted blocks
  return with their surviving docs byte-exact.
- **Why the phase order**: every server-side content writer goes structure, then
  doc, then projection.
- **Why `writeTexts` is a required parameter**: the editor cannot import the
  writer (a cycle), and a returned list of edits would be a step a caller could
  forget.
- **Why open editors need nothing special**: surviving ids stay mounted, text
  arrives as a remote doc push, revived ids bind to their surviving docs via
  `"removed"`; an open run on a rewritten block aborts, older entries replay as
  `stale-entry`.
- **Limit**: a fresh-id copy is re-minted on every restore of that version,
  since nothing records which copy stands for which version block.

**Why the offscreen-merge undo is a splice.** `$spliceRunsInto`'s prefix
alignment removes exactly the appended suffix and keeps every untouched unit's
CRDT item; a positional cut would not.

## Zoom (`rootId`)

Design:
[`research/2026-09-22-global-open-block-as-page.md`](../../../../research/2026-09-22-global-open-block-as-page.md).

**Why the data stays whole.** The client's predicted forest is then the
server's, and scoping only `setFlatOrder` scopes arrows, Cmd+A and the caret
surfaces for free.

**Why `expanded` is exempt from the backstop.** The reducer itself opens the
containers around a split, which may sit outside the scope.

**Why the merge asks before the append.** Otherwise the text lands while the
source row is still there.

**Why undo/redo patches are exempt.** They restore recorded states.

**Why map gestures onto in-scope ops.** So the backstop is rarely what the user
meets.

**Why the resolver gets `scopeRootId`.** It makes the root's children top level
(no Shift+Tab out, no excess outdent), keeps the root's first line from
unwrapping a zoomed container, and makes Enter on the root nest its tail.

**Why insert actions bypass the backstop.** `/page` and `/agent-page` are server
ops, not structural ops on this page's lane.

## In-memory mode (`persist={false}`)

**Why one store seam.** Everything else in the provider (recording, focus, the
CRDT projection) is storage-agnostic, and the memory store reuses the same pure
reducers, so op semantics are byte-identical to the server. With every row
authoritative from the start, the doc-init FK gate is inert.

**Why pending is a separate arm.** There is no `[]` placeholder document an op
could be folded onto, and no provider hook reads a whole-document `pending`. In
the composite, a pending child contributes no rows — never an empty list — and an
op routed to it throws because its rows are not on screen.

**Why the server store ships only intent while memory uses the prediction.** The
server's single `(parent_id, rank)` space is projected disjointly by several
resources; memory mode holds one synthetic page whole, so its prediction is
authoritative.

**Why the local provider never subscribes.** Subscribing would also need a
`NotificationsProvider` the demo does not mount. The local provider is
permanently `idle`, so the sync cloud stays silent.

**Why attachments are gated.** Blob storage needs a server.

**Why `TurnInto` is gated.** A `TurnInto` is a server-backed transition the pure
`convertTo` cannot express (e.g. re-partitioning `page_id` into a sub-page).

## The inline-token registry exists in BOTH runtimes

**Why one spec object.** The two runtimes then cannot name a different type
string, fields or token format.

**Why a source lookup for registry-backed sets.** A list handed over at module
eval freezes whatever tiers had loaded; the seed and the doc-sourced projection
then read different sets, which round-trips a decorator into plain characters.
Stable objects matter because the derived extension is cached on identity and
these walks run at caret frequency.

**Why the server registry exists.** It lets `markdown-apply` read and rewrite a
block whose doc holds a decorator.

### A token family declares its READ-ONLY rendering too

**The failure.** `read-only-view` as a hand-maintained list of two token types
painted `[[date:…]]` as literal brackets on every read surface for as long as
inline dates existed.

**Why the builder.** It erases `renderToken` soundly — a family is only ever
handed a field record its own `fieldsOf` produced — so contributors write typed
fields instead of narrowing erased ones by hand.

**Why `null` paints raw text.** Rendering nothing would silently delete a token
the document still holds.

**Why matches carry the registration.** A join back by `id` is a string key
nothing checks.

**Why the check.** A renderer racing two hardcoded token patterns is exactly how
the brackets shipped. The governed set is discovered from registrations, so a new
family is covered with no edit. Identity is co-owned by the plugin declaring the
shape and the one registering it as a token, which lets
`ui-context/element-picker` build a chip from `ui-context`'s own regex.

### Pasting a token materializes it

**Why each slot.**

- **Below NORMAL**: a file paste is an upload and a multi-line paste is
  structural; a token inside either must not hijack them. So this only sees
  single-line text.
- **Not above `UrlPastePlugin`**: the link menu is a shipped affordance (the gates
  are disjoint anyway).
- **Above EDITOR**: otherwise the token lands as literal characters and stays so
  forever — nothing re-scans an existing doc.

**Why no CRDT surgery helper.** That helper is for edits from outside a Lexical
command; a `PASTE_COMMAND` listener already runs inside `editor.update()`, so the
insert syncs through the binding and the run tracker records it like typing.

**Why no convert-as-you-type.** An id is only briefly complete while being typed
(the classic autoformat trap), on top of a CRDT with hand-written caret-offset
math. A raw id self-heals: any `edit_page` rebuilding the block materializes it,
and read-only surfaces chip it from `data.text`.

## Markdown is a LOSSLESS PROJECTION of the forest

Design:
[`research/2026-08-03-page-markdown-block-roundtrip.md`](../../../../research/2026-08-03-page-markdown-block-roundtrip.md).

**Why a generic `tag` fallback.** A type with no markdown declaration at all
(callout, image, video, audio, file, embed, bookmark) is still covered,
instead of serializing to `""`.

**Why the round-trip runs on the real registry.** A hand-written copy of the
handles drifts. The generator's type set is asserted equal to the registry's,
so a new type with no generator fails instead of quietly going untested.

**Why only strings become plain attributes.** An attribute value is a string both
ways, so `width="640"` would read back as the string `"640"` — lossy exactly
where the "prettier" form claims not to be.

**Why `body` is not derived from `collapsible: "always"`.** That set includes
`toggle`, which must keep emitting its children folded.

**Why typing prefixes are separate from markdown prefixes.** `quote` types with
`| `, which in markdown is a table row: one field for both would make a pasted
table a wall of quotes. Likewise `to-do`'s `[] `, `code-block`'s ```` ``` ````,
`equation`'s `$$`, `divider`'s `---` and `todo`'s `TODO ` — each has its real
markdown declared elsewhere.

**Why `prompt` declares `body: "text"`.** As the only text-bearing type with no
markdown prefix, it otherwise serialized as a bare paragraph and came back as
`text`.

**Blank lines and empty blocks.**

Design:
[`research/2026-09-01-page-blank-line-empty-paragraph.md`](../../../../research/2026-09-01-page-blank-line-empty-paragraph.md)
and
[`research/2026-09-03-page-edit-judged-on-what-it-changed.md`](../../../../research/2026-09-03-page-edit-judged-on-what-it-changed.md).

- **Why the dialect is a required field.** A call site that does not state its
  dialect is a tsc error rather than inheriting a default. Paste sites skip blank
  lines — correct CommonMark — because a pasted README must not gain a spacer
  between every two paragraphs.
- **Why some empty blocks must be pinned.** A blank line has no indentation, so
  the parser places it by the block that follows and drops a run with nothing
  after it. A node with children, the first of a sibling list and the last of
  one are therefore unstatable as blank lines.
- **Why beside a tag too.** In text an agent writes, a blank line beside a tag
  means spacing: `</human>\n\n<agent-inline>` minted an empty paragraph in the
  page's prose, outside the card, and the edit was refused. The drop is the
  agent's text's rule, never the parser's: a spacer already on the page stays.
- **Why the pin replaces only the line.** Routing through the tag branch would
  silently delete children — a `body: "none"` tag self-closes and consumes them.
- **Why read and planner must agree.** The read and the diff are one dialect, or
  alignment diffs two. The clipboard stays `"blank-line"`: a human pasting into
  another app must never see a tag, and the internal round trip travels as
  `BLOCKS_MIME` anyway.
- **Limit:** a whitespace-only paragraph is a blank line to the tokenizer and the
  tag means *empty*, so no dialect can spell it.

**Soft line breaks.**

Design:
[`research/2026-09-10-page-soft-break-markdown-round-trip.md`](../../../../research/2026-09-10-page-soft-break-markdown-round-trip.md).

- **The failure.** With the break emitted verbatim, the walk fanned one block
  into several lines at its indent, and the parser read them back as several
  blocks: an unchanged `read_page` → `edit_page` planned CREATES, which nothing
  can subtract. Pages became un-editable by agents.
- **What the escape also fixes.** A mark or link across a break is no longer
  dropped (`matchDelimiter` and `matchLink` abandon a construct at a real
  newline — those guards stay), and a block whose text is only a break is no
  longer deleted by the empty-block pin.
- **Why one rule in `escapeText`.** Every run-text path inherits it, including a
  `body: "text"` tag. Two spellings chosen by a condition an agent editing the
  body cannot see is worse than one spelling everywhere.
- **Why `line.split("\n")` stays.** `code-block` serializes a genuinely
  multi-line fence; at the split the line is opaque, so escaping there would
  collapse every fence onto one line.
- **Why assert one line.** A link href and a `"protect"` span emit bytes verbatim
  where the escape cannot reach; throwing names the run instead of corrupting it.
- **Accepted cost.** Decoding is unconditional, so a lone `\n` in foreign markdown
  (`C:\new`, `` `printf "a\n"` ``) becomes a break — the same class as the
  existing `\*`-in-code-span leniency.
- **Why edge breaks hoisting is fine.** The round trip is
  `parse(serialize(x)) === canonical(x)`; it lands as a text edit
  `subtractNoise` absorbs, never a create.

**Line-claim escapes.**

Design:
[`research/2026-09-20-page-markdown-line-claim-escape.md`](../../../../research/2026-09-20-page-markdown-line-claim-escape.md)
and
[`research/2026-09-20-page-markdown-claims-against-real-registry.md`](../../../../research/2026-09-20-page-markdown-claims-against-real-registry.md).

- **Why the parser's own dispatch.** One authority, so the two directions cannot
  disagree about what a line means. One backslash at index 0 defeats every
  claimer's `^`-anchor or `trim()`, and `\3. x` is correct CommonMark, so no new
  dialect field is needed.
- **Why probe the left-stripped line.** Leading whitespace is indent to the
  parser but content to a paragraph, so `"  3. x"` is escaped ahead of its
  spaces (`"  ---"` hides this, since `divider` compares `trim()`).
- **Why non-default types throw.** Escaping one would turn the block into a
  paragraph on the way back — the very loss this closes.
- **Why the asserts are our dialect only.** The clipboard is deliberately lossy
  and must never throw during a Cmd+C. Without the one-line assert, `equation`'s
  `"$$" + expression` fans a multi-line formula into sibling blocks; a `lines`
  line never opening with `<` lets the claim authority skip the multi-line tag
  branch honestly.
- **Why claimers declare their claims.** A regex like `/^\d+[.)]\s+(.*)$/`
  states its claim to nobody but the regex engine, and the escape rests on
  knowing who claims a line. The check is also the only thing pinning `to-do`
  above `bulleted-list` on `- [ ] x`. The hand-written fuzz alphabet it replaced
  picked words so no generated paragraph could open with a claimed line — exactly
  what let the bug through.

**Line runs.**

- **Why a third claim kind.** A GFM table has no closing line; its rows simply
  stop.
- **Why compare indent explicitly.** A deeper table is a child, never a
  continuation.
- **Why every serialized line must `matches`.** Otherwise the run ends there and
  the rest come back as siblings nobody wrote.
- **Why `protectedSpans` on both ctxs.** A table must not split a cell inside
  `\(a|b\)` or a `[[page:…]]` token. `mdLine` forces the escaped soft-break
  dialect because a real newline would end the row, even on the clipboard.

### The page tags

**Why parse never mints a human sub-page.** A human sub-page means minting a
`page_id` partition and restamping a subtree, which only the server's
turn-into-page op does. The id lets a markdown apply reconcile against the
existing row.

**Why the spelling's `data` preset does both jobs.** Picking the spelling on
serialize and merging over attributes on parse makes the round trip correct by
construction (and asserted).

**Why `<page>` titles are annotations.** A link's title lives on another row.

**Why a body on `<page>` is rejected.** A page's content lives in its own
partition; only `<agent-page>`'s mint form may carry a body.

**Why kind changes only through its own op.** The `BlockDataRewrite` brand makes
the op writer, the patch writer and `PATCH /api/blocks/:id` all refuse kind
changes by type construction. `BlockHandle.refine` exists because zod 3's
`.refine` could not state exclusivity. `<instructions-page>` is `pointerOnly` so
no agent mints one. History restore keeps the current kind, as it never moves
the page either.

**Why `renamePage` judges `requireAuthor` under the lock.** The human can flip
the page between the tool's decision and the write.

**Why `onlyIfUnset`.** An automatic writer must never overwrite a user's pick.
Taking an opener rather than a caller's transaction keeps the forest-lock
discipline.

**Why creates stay in the patch's world.** A create elsewhere would write into a
page not locked by this patch.

**Why parsed forests are expanded.** A self-closing tag cannot distinguish
"collapsed" from "childless", and blocks are born expanded.

### Reserved attributes: a tag may carry facts the block does not own

**Why not in `data`.** A TODO's task and its status live in another table;
copying them into `data` makes the block row a drifting second copy of someone
else's record.

**Why an absent value omits the attribute.** The clipboard has neither ids nor
annotations and must still serialize.

**Why parse deletes reserved names.** Otherwise the round trip is not closed: a
void `z.object({})` strips the key, a `.strict()` one 400s on a document this
side emitted.

**Why read-only.** The parser is pure: it cannot tell an agent's edit from the
value it emitted a minute ago, nor write the owning table.

**Why an undeclared annotation throws.** Emitting it would make it a `data` key
on the way back in; dropping it would lose a fact its supplier believes the
document carries.
