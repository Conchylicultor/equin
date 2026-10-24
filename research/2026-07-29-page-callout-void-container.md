# Callout as a void container anchor

## Context

`/callout` today is **one row playing three roles at once**: container identity
(the row's `type` is what makes a box exist), appearance (icon + tint), and the
first line of content (it owns `data.text`). Every reported symptom follows from
that fusion:

- **Enter makes a second callout, with its own icon.** Because the container *is*
  a content line, making another content line means making another container. The
  special case meant to prevent this — `splitChildWhenExpanded` — is gated on
  `node.expanded`, which is `false` for a freshly converted block, so it never
  fires on the interactive path. The DB confirms it: five sibling callout rows,
  not one callout with five children.
- **Converting the line to a heading destroys the callout**, because the line's
  type *is* the container's identity.
- **…unless the block is nested one deeper** — same cause: a nested child isn't
  the container.

Target model (what the original request actually asked for — "a container block
which can contain sub-blocks of arbitrary type; the callout just provides the
icon border"):

```
Callout            ← void container: {icon, iconSvgNodes, color}. No text.
├── Text  "first line"
├── Heading
└── Bulleted list
```

Children are ordinary blocks that do not know they are inside a callout;
converting a child's type can never touch the container. Visually it is Notion's
callout: the container occupies **zero height**, its icon sits in the gutter left
of the first child on that child's first line, and the tint wraps icon + all
children.

## The geometry decides the design

This is the crux, and it is a theorem, not a preference.

The tint starts at `C = blockContentLeft(depth)`. Children sit one indent in, at
`C + 24`. `BlockRow` pins each row's three hover controls relative to *its own*
content edge — chevron `-20`, drag `-40`, `+` `-60`, each 20px wide
(`block-row.tsx:97-156`). So the **first child's** controls occupy `[C-36, C+24]`,
while the icon must live in the 24px column `[C, C+24]`:

```
        │←─ first child's rail ──────────────→│
        │   +        drag      chevron        │
   C-60 │ C-36      C-16       C+4          C+24
        │  [___]     [___]      [_____]        
                            ┌───────────────────────────
                            │  💡      first line       ← icon [C, C+24]
                            │          collides with the
                          C │          chevron [C+4, C+24]
```

The overlap with the chevron is 20 of 24px. Worse, the child's row is *later in
DOM order* and its controls are already `z-raised`, so the icon is not merely
covered — it is **unclickable** wherever they overlap. Widening the child indent
does not help; the controls follow the child's content edge.

Only one resolution is self-consistent, and it is also Notion's:

> **A row inside a container frame seats its hover rail against the content edge
> of its outermost enclosing frame, not its own** — so the controls sit *outside*
> the tinted box, at `[C-60, C]`, leaving the icon column free.
>
> **The anchor row therefore has no rail of its own** (its slots would be
> identical to its first child's, on the same line). The callout is manipulated
> through its icon, which becomes what a drag handle already is: drag to move,
> click to open a menu.

This is forced. The anchor and its first child share one visual line; both cannot
own the rail there, and the child must keep its own handle. The consequence is
that the callout's icon popover absorbs the block actions
(`BlockActionsMenu`'s Duplicate / Delete / Turn into) alongside the existing
colour swatches and `IconPicker` — one target, one menu, plus drag-to-move, which
is exactly the affordance set the drag handle has today.

It costs a documented-invariant amendment: `page-column.ts:18-24` and
`editor/CLAUDE.md`'s "each row seats its gutter controls against its own content
edge" becomes "…against the content edge of its outermost enclosing frame, which
for an unframed row is its own". `BlockRow` takes `railLeft` as a prop; the
editor derives it from the `frameSpans` it already computes. Rows keep computing
nothing themselves, so the "hosts never compute the edge" invariant is intact.

## Model decisions

| Decision | Why |
|---|---|
| Callout schema drops `textBlockSchema` → `{icon, iconSvgNodes, color}` | `acceptsText` is *derived* (`"text" in schema.shape`, `define-block.ts:219`), so voidness falls out with no new flag, and `parseBlockData`'s `.strict()` then rejects a stray `text` — which is the migration's own guard. |
| The anchor row is zero-height **only while it has visible children**; with none it renders a one-line empty box | `computeFrameSpans` deliberately spans a childless/collapsed container over its own row alone (`block-frames.ts:44-49`). At zero height that is an invisible, unclickable, undeletable black hole. Making the collapse *conditional* removes the failure mode structurally instead of relying on an invariant four write paths bypass. |
| `collapsible: "never"` (widen the existing `collapsible?: "always"`), and the flatten ignores `expanded` for these types | A collapsed anchor has no chevron to recover it. Making the flag **inert at flatten time** is a guarantee; "creation sets `expanded: true`" is not — `applySplit:417`, `applyInsert:798` and any patch replay mint it `false`. |
| Creating a callout is a **wrap**, not a type swap: the origin row keeps its id, type, data and children and becomes the anchor's first child; a new row is minted for the anchor | Keeping the origin id preserves its `page_block_docs` Yjs doc, its `Y.UndoManager` and its registered `BlockFocusHandle`, so the caret simply stays put — no `focusNew`, no remount race. The *new* id goes to the anchor, which is void and never opens a content doc, so the doc-init FK gate applies to neither row. Not retyping the origin makes `/callout` work on a heading, to-do, image or code block for free. |
| Backspace at the start of the first child **unwraps** the callout | See below. |
| An empty anchor is pruned in one place (`applyBlockOp` post-pass) | Covers the ops that route through the reducer. `bulkDelete`/`bulkMove`/`paste` bypass it on both sides — but thanks to the one-line fallback a missed prune yields a *visible, deletable* empty callout rather than a ghost. |

## New seams (the editor core still never names a block type)

- **`BlockHandle.anchor?: true`** (core) — *this type renders no line of its own.*
  In `core` because the **reducer** needs it (the prune, and the split/merge
  refusals) and the server has no slots.
- **`anchor` component field on the `Editor.BlockFrame` contribution** (web) —
  the glyph. It rides on the same registration that paints the box, so a type
  cannot claim anchorhood without actually being a container.
  `defineDispatchSlot` already supports contribution extras (`Extra extends
  object`), which is how `BlockMeta.block` rides on `Editor.Block`. `useBlockAnchors()`
  derives the map exactly like `useFramedBlockTypes()` does today.
  A `./equin check` fails a handle that declares `anchor: true` whose plugin
  contributes no anchor component — the two live where each is needed and cannot
  silently disagree.
- **`BlockHandle.wrapOnConvert?: true`** — *converting a block INTO this type is a
  wrap.* Resolved inside `convertTo`, so no caller changes: the `/` menu, the
  gutter-`+` draft, Turn-into and `url-paste` all keep calling
  `api.convertTo(type, data)`.
- **`collapsible: "always" | "never"`** — widened, not a second concept.
- **`BlockOpContext { anchorTypes?: ReadonlySet<string> }`** — optional third param
  on `applyBlockOp`. Defaulting to `{}` keeps every existing test, property test
  and fuzz seed byte-identical. Parameterised on data, not a slot import — the
  precedent `core/markdown.ts` already sets.
- **`IntentContext.acceptsText(node)`** — replaces **both** hardcoded
  `PAGE_BLOCK_TYPE` comparisons in `keystroke-intent.ts`.
- **`FlatBlock.firstVisibleChildType`** — so the anchor can borrow its first
  child's line height (below).

The glyph must not position itself: `BLOCK_GUTTER` is deliberately not exported
from the web barrel and `BlockRendererProps` carries no `depth`, so `BlockRow`
owns the anchor column (`left: contentLeft`, `width: BLOCK_INDENT`, `z-raised`)
and the contribution renders appearance + interaction only.

## Vertical seating

The anchor has no line of its own, so `--gutter-first-line-center` — derived from
a row's *own* handle (`block-row.tsx:83-85`) — is structurally unknowable for it.
Hardcoding the body centre puts the icon ~6px high against an H1 first child (and
tens of px off against a divider/image child that declares its own
`gutterFirstLineCenter`), and the error grows with the density preset.

`flattenTree` already sits where the answer is known — it pushes the parent, then
recurses into `node.children`. It gains `firstVisibleChildType`, `BlockRow`
resolves the centre from *that* handle when it is an anchor, and a post-flatten
pass walks forward through nested anchors (an anchor's first child is always the
immediately-following flat entry). Extract the existing expression into one
`gutterFirstLineCenter(handle)` helper so the two call sites cannot drift.
`define-block.ts:130-148`'s doc gains the note that a surface may borrow it.

## Escaping the box

The generic Backspace ladder resolves "start of the first child" to the
`isIndented` → **outdent** rung. For a one-line callout that is right (the line
pops out, the anchor is pruned). For a multi-line callout it is not: `outdentOne`
adopts the followers, so the first line pops out *and takes the rest of the
callout's content with it as its own children* — a re-nesting nobody asked for.

So add a reducer op `{kind: "unwrap", blockId}`: delete the anchor, promote its
children into its slot with `Rank.nBetween` in the parent's space. Backspace at
the start of an anchor's first child resolves to it, and the icon menu gets
"Remove callout" for free.

```
┌──────────────────┐
│ 💡  ^first line  │            first line
│     second line  │   ──▶      second line
│     • bullet     │            • bullet
└──────────────────┘
```

## Keystrokes: one real hazard, fixed generically

Everything else falls out of the existing ladders unchanged — Enter in a child is
an ordinary sibling split; Tab / Shift+Tab nest and un-nest with no
callout-specific logic; arrow navigation already skips the anchor because it
registers no focus handle (`block-editor-context.tsx:1187-1198`). Do **not** give
it a focusable zero-size element: `sub-page` registers `{focus}` because it is a
real clickable row; the anchor has no row to focus, and a 0×0 focus target would
land the caret nowhere visible.

The hazard: **Delete at the end of the line immediately above a callout.**
`nextVisibleLine` returns the anchor and the guard there refuses only
`PAGE_BLOCK_TYPE`, so `applyMerge` writes `data.text` onto a void anchor (400 at
the write boundary) and **dissolves the callout on one keypress**. Generalising
that guard from "is a page row" to `!acceptsText` fixes it *and* the same latent
bug that exists today for `divider` / `image` / `embed` / `file` (Delete above a
divider resolves to `mergeNext` and 400s). Delete there becomes `nav right`.

Deliberately **not** doing: making `prevVisibleLine`/`nextVisibleLine` *skip*
anchors (true Notion parity, where Delete above a callout merges its first line
up). More correct, but it edits the two functions the entire visible-line
invariant rests on — a separate change with its own duality property test.

## Ordered implementation

1. **Core seams, no behavior change.** `editor/core/define-block.ts`: `anchor`,
   `wrapOnConvert`, widened `collapsible`. `editor/core/block-ops.ts`:
   `BlockOpContext`, generalized `applySplit`/`applyMerge` refusals, the
   `pruneEmptyAnchors` post-pass, the `unwrap` op.
2. **Thread the context** through `web/internal/optimistic-block-ops.ts`,
   `web/block-store.ts`, `web/block-editor-context.tsx`, and
   `server/internal/handle-apply-block-op.ts` (set built from
   `server/internal/block-registry.ts`).
3. **Resolver generalization.** `web/internal/keystroke-intent.ts` gains
   `acceptsText` and loses its `PAGE_BLOCK_TYPE` import; `keyboard-plugin.tsx`
   supplies it from `contributionsRef`. Add the `unwrap` rung.
4. **The wrap.** Generalize `commitRow` → `commitRows(transform: (rows) => rows)`
   in `web/block-editor-context.tsx` (`patchesFromDiff(diffBlocks(...))` already
   operates on the whole array, so the "one chokepoint" property is preserved
   verbatim, now as one row-*set* chokepoint), then branch `convertTo` on
   `handle.wrapOnConvert`. One patch ⇒ one undo entry ⇒ the prune is never
   observed mid-flight. Give the anchor a fresh rank strictly before the origin
   rather than reusing the origin's, so the wrap never depends on `parkRanks`
   (the memory store has none).
5. **Anchor chrome.** `web/types.ts` gains `BlockAnchorProps` (and its
   `BlockFrameProps` "cannot host controls" note points at the anchor as the
   sanctioned interactive companion, with the paint-order reason). `web/slots.ts`
   gains `BlockFrameMeta.anchor` + `useBlockAnchors()`.
   `web/components/block-row.tsx` gains the anchored branch (no rail, anchor
   column, `min-height` fallback when childless, `railLeft` prop for every row).
   `web/components/block-editor.tsx` derives `railLeft` and the borrowed
   first-line centre from the `frameSpans` + flatten it already computes.
   `block-document-scale.css` gains `.block-anchor`, documented beside
   `.block-gutter-control`.
6. **Geometry fixes the zero-height row exposes** (all in `block-editor.tsx`):
   `rowAtPointer` gains `r.height > 0` on the containment test **keeping** the
   nearest-distance fallback (that fallback is what makes "drop before a leading
   callout" reachable); the anchor's drop indicator renders the `"before"` arm
   only; `onEmptyClick`'s top branch skips handle-less rows before falling back to
   `applyRange` (otherwise clicking above a leading callout *selects* it instead
   of caretting); and the block-selection ring moves onto the frame's
   grid-spanning wrapper, which both fixes the invisible selection on a 0px row
   and is the better visual — selecting a callout rings the whole box.
7. **Callout plugin.** Void schema + `anchor` / `wrapOnConvert` /
   `collapsible: "never"`; `callout-block.tsx` → `callout-anchor.tsx` (renders the
   picker when `editor` is present, a static glyph when not); `web/index.ts`
   contributes the anchor on the existing `Editor.BlockFrame`, and keeps a
   null-rendering `Editor.Block` (that registration is where the handle lives for
   the palette, markdown, paste and `defaultTextHandle`); rewrite
   `callout/CLAUDE.md`.
8. **read-only-view.** Delete the `handle.type === "callout"` branch
   (`read-only-blocks.tsx:113-140`) and its duplicated colour map (`:79-85`); add a
   generic anchored branch *before* the `isTextLike && hasText` arm, which the
   anchor now fails and would otherwise land on the "Unknown block" placeholder —
   the trap `PAGE_BLOCK_TYPE` is already documented to fall into. That surface
   renders recursively with `inset: 0` and no rail, so the same geometry falls out
   for free with no collision.
9. **Migration** (below).
10. **Docs.** `editor/CLAUDE.md` gains "A container that owns no text: the anchor
    row" under "Container frames", plus the amended rail sentence in "The page
    column". `./equin build` regenerates the autogen blocks.

## Migration

Scale: main has **5** live callouts, **0** with children, 4 with empty text. This
worktree has ~23 (dev data). Favour clarity over cleverness.

Vehicle: a DML data migration —
`./equin build --custom-migration --migration-name callout_anchor_split`,
hand-edited under `plugins/database/plugins/migrations/data/`. Precedent:
`20260710_120000_577ba77b__repair_block_data.sql` does the same class of change
(strip a stray `text` key from void block types).

Three statements, each guarded `WHERE type='callout' AND data ? 'text'`
(idempotent — post-migration anchors carry no `text` key):

```
S1  INSERT anchor A: id = 'ca-'||r.id, page_id/parent_id = r's, rank = r.rank||'0',
    expanded = true, type = 'callout', data = {icon, iconSvgNodes, color}
S2  UPDATE r: parent_id = 'ca-'||r.id, rank = 'a0', type = 'text',
    data = jsonb_build_object('text', COALESCE(r.data->'text','[]'::jsonb))
S3  UPDATE A: rank = left(rank, -1)
```

**Why the temp rank is collision-free.** `page_blocks` has non-deferrable partial
unique indexes on `(parent_id, rank)` (`tables.ts:66-75`), so the anchor cannot
transiently hold the rank it is displacing. `fractional-indexing`'s
`validateOrderKey` throws when the **fractional** part of a key ends in `'0'`
(`node_modules/fractional-indexing/src/index.js:105-118`). `r.rank || '0'` keeps
`r.rank`'s integer part (its length is fixed by the first character) and appends a
fractional part ending in `'0'`, so it is not a valid order key and cannot equal
any stored rank — under any parent, at root level, or between two callouts
migrating at once. `rank_text` is a bare `TEXT COLLATE "C"` domain with no CHECK,
so it is storable; S3 restores the exact original rank, so the transient ordering
never matters. (The simpler claim "no generated rank ends in `'0'`" is **false** —
`generateKeyBetween(null, null)` returns `"a0"`, the most common rank in the table.)

Consequences, all checked:

- **Content docs survive.** `r` keeps its id, so its `page_block_docs` Yjs row is
  untouched (`data.text` is only the ~1s projection; the doc is the real text). No
  stale doc can be keyed to an anchor — anchor ids are brand new and
  `page_block_docs` rows are only ever created by `doc-init`, which a void block
  never calls.
- **Existing children** stay parented to `r`, ending up nested one level under the
  new text line rather than as siblings of it. This preserves the pre-migration
  *visual* indentation exactly (they were already one indent right of the callout
  line, inside the tint) and needs no rank arithmetic. main has zero such rows.
- **Nested callouts** resolve in one pass because each statement is set-based over
  the whole table.
- **FKs / triggers / derived tables / `page_blocks_ext_*`**: nothing breaks (`r`
  keeps its id; S1 precedes S2). **Search / backlinks** need no kick —
  `buildPageSearchDoc` derives its body from all content blocks, so the content
  hash is unchanged.
- **Version history back-compat.** `entity_versions.snapshot` is
  `{page, blocks: StoredBlock[]}` — a *flat* array — holding pre-migration
  callouts with a `text` key, which `replacePageContent` → `parseBlockData` would
  400 on. The same migration rewrites matching snapshots (`source_id = 'pages'`),
  retyping those entries to `text` with `data = {text}`. Lossy for
  already-superseded versions only (their icon/tint), and loud-free.

## Verification

- `bun test plugins/page/plugins/editor/core/block-ops.test.ts` plus the
  `keystroke-intent`, `block-frames`, `block-forest`, `markdown` and
  `optimistic-block-ops` suites; `bun run test:dom plugins/page/plugins/editor`.
- `./equin check` — notably `migrations-in-sync` and
  `migration-applies-clean`, which dry-runs the DML against main.
- `./equin build`, then drive the real app at
  `http://att-1785247005-nn1x.localhost:9000`.

**Rewrite** — `callout/core/callout-block.test.ts` (both cases assert
`calloutDataSchema.text`) → assert the schema *rejects* `text`, `empty()` is
exactly `{icon, iconSvgNodes, color}`, and `acceptsText === false` /
`text === undefined` (pinning the derivation, not the shape).

**Rewrite** — `callout/e2e/callout-container-verify.ts`. Its API seed posts
`data: {text, icon, …}` to a now-void schema (400) and its step 4 tests
`splitChildWhenExpanded`, a seam that no longer exists. New assertions: the anchor
row's height is 0 while it has children; the icon's box lies within `[C, C+24]`
and is **clickable with an expanded first child** (the collision regression); its
vertical centre is within ~2px of the first child's first-line centre; Enter at the
end of the first child yields a **sibling text block still inside the tint**, not a
second callout; `/h1` on the first child leaves tint and icon intact; Backspace at
the start of the only child pops it out and the callout disappears; a childless
callout renders a visible one-line box. Keep the Tab-in / Tab-out caret-survival
probe unchanged — it is the load-bearing frame test.

**New** — `callout/e2e/callout-wrap-verify.ts`: type text, `/callout`, assert the
origin keeps its `data-block-id`, the caret stays at its offset, and **one** Cmd+Z
restores the pre-wrap state.

**Update** — `block-ops.test.ts:244-310` (three cases use a text-bearing callout;
retarget at `to-do`/`heading` — the rule is generic and must stay pinned), plus:
empty `anchorTypes` is byte-identical to today; outdenting an anchor's only child
prunes it; merge refuses an anchor as source and as target; `pruneEmptyAnchors`
never touches a childless `PAGE_BLOCK_TYPE` row (the catastrophic false positive);
the split∘merge round-trip property runs over a forest containing anchors.
`keystroke-intent.test.ts` gains the anchor + divider `nav right` cases, and its
`multi-page union boundaries` describe is re-expressed through `acceptsText` with
identical outcomes — that re-expression *is* the regression test for the
generalization. `block-frames.test.ts`'s `entry()` fixture gains the new field.

## Accepted trade-offs

- **Icon breathing room.** The icon column is exactly one `BLOCK_INDENT` (24px)
  flush against the tint's left edge, so the callout reads tighter than Notion's.
  Widening it would need a callout-specific child indent (not generic) or letting
  `CalloutFrame` inset its tint, contradicting "the tint bleeds to `C`".
- **Handles collapse to one x inside a callout.** Under the outermost-frame rail
  rule, a block nested three deep inside a callout gets its handle at the same x
  as the callout's first line. Content indentation still shows depth.
- **`bulkDelete` / `bulkMove` / `paste` can leave an empty callout.** They bypass
  the reducer on both sides. It is visible, selectable and deletable via the icon
  menu, so this is a cosmetic gap, not a ghost row.
- **The anchor component is unsealed** (only a field literally named `component`
  goes through the slot middleware/error-boundary chain), so a crash in it is not
  contained. Precedent: `BlockHandle.icon` is rendered raw today. Documented, not
  discovered.
