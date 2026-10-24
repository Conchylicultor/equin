# Collapsible void containers (`callout` + `/context`)

## Context

The page editor's two **void containers** — `page/callout` (solid tint) and
`page/context` (dashed box) — declare `BlockHandle.anchor: true`: they own no
text and render no line of their own, their displayed content IS their children.
Both are therefore forced to declare `collapsible: "never"`
(`plugins/page/plugins/container/core/define-container-block.ts:133`) and cannot
be folded.

That is a real problem for `/context` in particular, whose entire purpose is
holding standing instructions a human reading the page usually wants out of the
way; a long callout has the same complaint.

Two things stood in the way, both recorded in
[`plugins/page/plugins/editor/CLAUDE.md`](../plugins/page/plugins/editor/CLAUDE.md):

1. An anchor has **no chevron left to reopen it** once collapsed — it renders no
   line to hang one on.
2. Every creation path mints `expanded: false` (`applySplit`, `applyInsert`,
   patch replay), so *making the stored flag inert* was the only guarantee that
   an anchor's children stay visible.

The decision below dissolves (1) rather than working around it, and demotes (2)
from a safety mechanism to hygiene.

## The decision

**Fold to the first child's line.** The anchor already borrows its first visible
child's first line — for the gutter seat, via `borrowedFirstLineCenters`
(`web/components/block-editor.tsx:151-190`). Collapse borrows the *same* line:

> A collapsed container renders exactly its first visible LINE and nothing else.

So "hide everything below my own line" becomes the identical rule ordinary
blocks already follow, the first line never moves between states, and the
control never jumps. Expressed as two rules:

- **R1** — an anchor always descends into its first child, collapsed or not (its
  own line IS that child's).
- **R2** — the borrowed line of a **collapsed** anchor has no visible children
  and no visible following siblings.

### Why this retires the `collapsible: "never"` argument

Because a collapsed container still paints a real line with a visible
affordance, **content can never hide behind nothing** — the failure mode the
inertness existed to prevent is no longer expressible. The worst case a stray
`expanded: false` can produce (a hand-written `PATCH /api/blocks/:id`, a pasted
`SerializedBlock` — both client-supplied, `core/endpoints.ts:30`,
`core/serialized-block.ts:22`) is a visibly-present card, one line tall, with a
pinned chevron and an Expand item in its own popover. That is a *stronger*
guarantee than inertness, and it is what buys the feature.

### Where the affordance lives

The container's chevron occupies the chevron slot at `railLeft - 20` **on the
borrowed line**, and is **rendered by that line's own row**, not by the anchor
row. This is forced, not preferred:

- `computeRailLefts` (`block-editor.tsx:134-149`) seats an anchor and its whole
  subtree at one `railLeft`, so the container's slot and the first child's are
  the same 20px box at the same x and y. There is exactly one, and a fourth
  gutter position at `railLeft - 80` overflows the 64px `BLOCK_GUTTER`
  (`internal/page-column.ts:44`).
- A chevron in the *anchor* row is unreachable: gutter controls are
  `opacity-0 pointer-events-none` until `group-hover/row` (`block-row.tsx:221`),
  and the anchor row is zero-height by design (`block-row.tsx:150-155`), so
  nothing can hover it. Collapse would be impossible while expanded. This is
  verbatim the deadlock `page-column.ts:24-31` already documents.

**Ownership rule** — the container claims the slot only when the line's own
block does not use it:

> On a borrowed line the chevron belongs to the **container**, unless that
> line's own block already needs one — it has children of its own, or its handle
> declares `collapsible: "always"`. Then it stays the child's and the container
> folds from its popover. A container with exactly one child has a trivial fold
> and claims nothing.

The `collapsible: "always"` half is load-bearing, not politeness: `toggle`
(`toggle-block.ts:18`), `sub-page` (`sub-page-block.ts:23`) and `page-link`
(`page-link-block.ts:17`) all declare it, and for the latter two that chevron is
not a fold at all — it drives the composite-union **mount**
(`web/internal/composition.ts:76`). Taking it would remove the only way to
expand a nested page inline.

The allocation follows from reachability: the container has a popover fallback,
the child has none. The decoration column (glyph → icon/colour popover, drag) is
**unchanged**, so the callout's existing interactions are untouched.

## Design

### 1. One visibility predicate, in `core`

R1/R2 must hold identically in four places that today each re-encode the
visibility rule:

| Site | Today |
|---|---|
| `web/components/block-editor.tsx:95-121` | `flattenTree`, via the `alwaysExpanded` set |
| `core/block-ops.ts:244` | `prevVisibleLine` — `while (cur.expanded)` |
| `core/block-ops.ts:262` | `nextVisibleLine` — `if (node.expanded)` |
| `web/internal/keystroke-intent.ts:157` | `hasExpandedChildren` |

Add to `core/block-ops.ts` and consume from all four:

- `borrowedLineOf(blocks, anchor, anchorTypes)` — walk first children while the
  node is an anchor with children; returns the first row that actually renders a
  line. This is the **same walk** `borrowedFirstLineCenters`
  (`block-editor.tsx:171-176`) already performs on the render side; that walk
  should be re-expressed in terms of this one.
- `isBorrowedLineOfCollapsed(blocks, node, anchorTypes)` — true when `node` is
  the borrowed line of a collapsed anchor **anywhere in its first-child ancestry
  chain**. The ancestry walk is required, not defensive: R2 must resume the
  sibling walk at the **outermost** collapsed anchor of the chain, or Delete at
  the end of the borrowed line splices hidden text into the visible line.
- `visibleChildrenOf(blocks, node, anchorTypes)` — `[]` when
  `isBorrowedLineOfCollapsed(node)`, else the existing `childrenOf`.

`prevVisibleLine` / `nextVisibleLine` take `anchorTypes` as a new parameter.
That is a signature change on two `core/index.ts` exports; every caller already
has the set in scope (`block-ops.ts:687`, `block-editor-context.tsx:1167` and
`:1388`, `keystroke-intent.ts:285` and `:320`). The **server reducer path**
(`server/internal/handle-apply-block-op.ts:48`) must pass the identical set or
the two sides diverge and ops never confirm.

`prevVisibleLine`'s descent becomes "last **visible** line": a childless anchor
returns itself (the surface renders its real one-line fallback box,
`block-row.tsx:189-191`), a collapsed anchor returns its borrowed line, and an
expanded anchor or ordinary block recurses into its last child as today.

Also route through `visibleChildrenOf`: `applySplit`'s adoption gate
(`block-ops.ts:626`) and the `asChild` decision for Enter-at-end
(`keystroke-intent.ts:217-218`) — both currently read the block's own
`expanded` and would otherwise nest new content into a hidden slot.

### 2. Structural ops open what they write into

`applyInsert` (`:1145`), `applyPaste` (`:1099`), `applyMove` (`:1226`),
`applyMerge` (`:736`), `indentOne` (`:766`) all already force-open their
destination parent. **`applySplit` is the outlier** and must join them: without
it, Enter mid-sentence on the borrowed line of a collapsed container moves the
tail into A's 2nd child — not flattened, no `BlockRow`, no Lexical instance —
while the executor has already run `focusNew` and `truncateAt` on the origin's
live doc (`block-editor-context.tsx:1345-1372`). The text after the caret
disappears and the caret strands. This is latent today only because a caret can
never sit inside a collapsed subtree; R1 is exactly what breaks that.

Same hole client-side, same fix: `move` (`block-editor-context.tsx:907-938`),
`fileDropPosition` (`block-editor.tsx:1024-1039`) and `onDragEnd`'s bulk arm
(`block-editor.tsx:988-1003`) must force-open the destination parent (client
overlay **and** server handler).

The unifying rule to state in the docs:

> Content lands where it can be seen — any op that writes into a collapsed
> container opens it.

**One new ladder rung**, above `unwrap` in `keystroke-intent.ts:255-256`: on the
borrowed line of a *collapsed* anchor, Backspace-at-start **expands the
container and consumes the keystroke**. Without it, `unwrap` dissolves the box
and promotes the n−1 children the user cannot see from one keypress; refusing
and falling through is worse — `prevVisibleLine` is the anchor (`acceptsText`
false), so it lands on the `isIndented → outdent` rung, and `outdentOne`
(`block-ops.ts:776-799`) adopts the hidden followers as the child's own
children. That is precisely the silent re-nesting `unwrap` exists to prevent
(`block-ops.ts:104-118`), now with invisible content. Shift+Tab
(`keystroke-intent.ts:327-329`) needs the same guard. This matches the ladder's
stated spirit — one structural level per press.

### 3. The affordance

- `web/internal/block-frames.ts` / `block-editor.tsx` — alongside `railLefts`
  and `borrowedFirstLineCenters`, resolve a `chevronFor?: { blockId, collapsed }`
  per flat index and hand it to `BlockRow`. Resolving the owner **and its
  collapsed state** centrally is required: `collapsed` is derived locally today
  (`block-row.tsx:106`) and re-deriving it per row makes a claimed chevron
  render its own block's state, i.e. lie.
- `web/components/block-row.tsx` — the existing chevron button (`:211-226`)
  takes its target from `chevronFor` when present, otherwise its own block.
  Keep the pinned-while-collapsed treatment (`collapsed ? "opacity-60"`) — that
  is what makes a folded card reopenable. The anchor branch (`:156-199`) gains
  no chevron.
- `plugins/page/plugins/container/web/components/container-anchor.tsx` — the
  popover gains an **Expand / Collapse** item above the `Remove` / `Delete`
  structural actions, rendered whenever the container has something to fold.
  This is the universal fallback (nested containers share one borrowed line;
  a `collapsible: "always"` first child keeps the slot) and the guaranteed
  recovery from a client-supplied `expanded: false`.
- `web/types.ts` — `BlockAnchorProps` gains `expanded: boolean` so the shell can
  label and drive that item.

### 4. Storage

Reuse the existing `expanded` column — a stored page edit, exactly as toggle
collapse is today. `setExpanded` already flows through `commitRow` with
`record: false` (`block-editor-context.tsx:1259-1264`, deliberately off the undo
stack), the column is in the live-state projection (`core/schemas.ts:41`), and
both `isPatchAbsorbed` and `isPatchReflected` compare it
(`web/internal/optimistic-block-ops.ts:175`, `:205`) — so a fold is a real patch
that confirms. **No schema change, no migration.**

`defineContainerBlock` drops the forced `collapsible: "never"`
(`define-container-block.ts:133`). Since containers were the only declarers,
`"never"` and the `alwaysExpanded` machinery in `flattenTree`
(`block-editor.tsx:393-401`) become dead — **delete both**, narrowing
`collapsible` to `"always" | undefined`. Leaving an inert-flag mechanism whose
entire documented rationale has been removed is exactly the drift the repo
guards against.

**Hygiene, independently revertable:** make "a block is born expanded" true
rather than incidental. All four `false` mints are childless-at-birth, so the
value is unobservable there: `core/block-ops.ts:577` (Enter-at-start's above
sibling), `:657` (tail), `:1155` (`applyInsert`'s new node), plus
`block-editor.tsx:685` and `:1086` (pasted / dropped attachment blocks). The DB
default is already `true` (`server/internal/tables.ts:41`) and `wrapInContainer`
— the only way a container is born — already mints `true`
(`block-editor-context.tsx:1128`). This is *not* the safety mechanism; §"Why
this retires the argument" is.

## Known limitations, recorded deliberately

- **Nested containers share one borrowed line.** `computeRailLefts` seats a
  whole span at the outermost frame's edge, so an inner container's chevron
  would want the same slot. Only the outermost claims it; the inner folds from
  its own popover — reachable because each container's decoration column sits at
  its own `blockContentLeft(depth)`, one `BLOCK_INDENT` apart.
- **The chevron's presence depends on the first child's structure.** Adding a
  child to the first block hands the slot back to it and the container falls
  back to its popover. Position never changes, only presence.
- **Read-only surfaces still render everything.** `read-only-view` ignores
  `expanded` by design (`read-only-view/web/node.ts:21`), as do markdown
  serialize, copy/paste (`web/serialize-blocks.ts:6`) and search indexing. A
  fold is an editing-surface view state. The consequence worth writing down:
  the editor and the version-history **diff** preview disagree about what the
  document shows.

## Verification

**Unit —**

- `core/block-ops.test.ts`: extend `randomForest` (`:1840-1862`) to mint
  anchors, and add a **duality fuzz round over `anchorize(randomForest(...))`**
  with random anchor `expanded`. The existing 3000-seed duality test
  (`:2188-2218`) has **zero anchor coverage**, and its `isVisible` helper
  (`:2196-2203`) encodes all-or-nothing collapse — so it would pass vacuously on
  exactly the case that matters. Rewrite `isVisible` to call the shared core
  predicate rather than re-encode the rule a third time. Force these shapes:
  collapsed anchor as its parent's **last** child (the upward resume path);
  collapsed anchor whose first child is itself a collapsed anchor; anchor whose
  first child is a childless anchor (reachable — `bulkDelete`/`bulkMove` bypass
  the prune, `:508-513`); collapsed anchor adjacent to a page boundary.
- `core/block-ops.test.ts:239, 419, 428, 443, 1062` — flip to `toBe(true)` for
  the born-expanded change, with a comment stating the invariant.
- `web/internal/keystroke-intent.test.ts:841-908` ("void lines") — extend with
  the collapsed-container cases: Backspace-at-start expands rather than
  unwraps; Shift+Tab likewise; Enter mid-line opens the container and keeps the
  tail visible; Delete at the end of the line above a collapsed container still
  resolves `nav right`; Backspace at the start of the line after one merges into
  the borrowed line.
- `define-container-block.test.ts:24`, `callout-block.test.ts:49`,
  `context-block.test.ts:33` — all three assert `collapsible === "never"`;
  update to pin that containers are now foldable.
- `web/__tests__/structural-undo.test.tsx` — unchanged expectations, but confirm
  the quadruple still holds with a collapsed container in the fixture.

```bash
bun test plugins/page/plugins/editor/core plugins/page/plugins/container/core
bun run test:dom plugins/page/plugins/editor
```

**E2E —** new `plugins/page/plugins/container/e2e/container-collapse-verify.ts`
(the behaviour is the primitive's; both containers exercise it). It must assert
the things jsdom cannot: the chevron is **hoverable and clickable** on the
borrowed line while expanded (the deadlock this design exists to avoid), the box
stays one line tall when collapsed, the first line does not move between states,
Enter on a collapsed card's line keeps the tail visible, and a reload preserves
the fold. Pair with the existing `callout/e2e/callout-container-verify.ts` and
`context/e2e/context-container-verify.ts`.

```bash
./equin build
bun plugins/page/plugins/container/e2e/container-collapse-verify.ts --headed
```

**Manual —** at `http://att-1785418968-kadw.localhost:9000`: `/context` on a
block, add several children, fold from the chevron and from the popover; check a
first child that is a toggle (slot stays the child's, container folds from the
popover), a nested `/context` inside a callout, and a one-child container (no
chevron claimed).

```bash
./equin check
```

## Docs to update

- `plugins/page/plugins/editor/CLAUDE.md` — the four anchor rules in
  "A container that owns no text: the anchor row"; rule 2 (`collapsible:
  "never"`) is replaced by the borrowed-line fold and its structural guarantee.
  Add the visible-line rule R1/R2 to "Visible-line invariants" and the
  "content lands where it can be seen" rule.
- `plugins/page/plugins/container/CLAUDE.md` — `defineContainerBlock` now forces
  two facts, not three; document the chevron ownership rule and the popover
  fallback.
- `plugins/page/plugins/context/CLAUDE.md` — "**Collapsibility is deliberately
  gone**" is now false; replace with how the fold works and why it needed no
  header row.
- `core/define-block.ts:174-181` — the `collapsible` doc comment currently
  carries the anchor rationale; rewrite for the narrowed `"always" | undefined`.
