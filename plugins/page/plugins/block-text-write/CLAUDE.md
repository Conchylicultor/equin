# block-text-write

The one server-side text channel. A block's text has exactly one owner — its
per-block `Y.Doc` (`page_block_docs`, stored by `page/editor-collab`) — and
`page_blocks.data.text` is a projection of it. A server-side writer with no
mounted editor (markdown apply, history restore) that wants a block to read
some runs cannot write the row: it must edit the doc, then write the
projection. This plugin is that write, so each writer does not grow its own.

```ts
import { writeBlockTexts } from "@plugins/page/plugins/block-text-write/server";

// AFTER the structural write has committed:
await writeBlockTexts(pageId, [{ blockId, runs }, …]);
```

**Why a plugin of its own.** It cannot live in `page/editor` (that would be a
cycle: `editor-collab` imports `editor`), nor in `page/editor-collab`, whose
charter is content-agnostic bytes — a runs-aware or Lexical-aware export would
breach it. And history restore must not depend on the markdown engine to reach
it. Design:
[`research/2026-09-11-page-history-restore-preserves-block-identity.md`](../../../../research/2026-09-11-page-history-restore-preserves-block-identity.md)
§4.

## The write order (`server/internal/write-block-texts.ts`)

Structure first — the caller's own `applyPageBlockPatch`, one locked
transaction — then text, because `page_block_docs.block_id` FKs onto
`page_blocks.id`, so a created block has no row to hang a doc off until the
patch lands. Within the text step, every DOC before any ROW: `data.text` is a
projection, so a row write is downstream. The row projections batch into one
final patch, so a failure writing a doc leaves every row as it was.

**The projection is not optional.** `useTextProjection` needs a *mounted*
editor, so a doc written for a page nobody has open would leave `data.text`
stale forever — and search, backlinks, history and `read-only-view` all read
it. This writes the value a mounted client eventually would, so a later client
flush is an empty diff rather than a fight.

The projection's update restates the row's WHOLE `data` blob (`text`
replaced), so the rows are re-read just before it — a field another writer set
while the docs were being written would otherwise be written back over.

**Idempotence is the recovery story.** A failure throws naming the block, and
can leave some docs written and no row projected. Every step is a pure function
of current state, so re-running the same write converges. There is no retry
loop and no rollback. A named block that is not a live block of the page is
refused loudly, not skipped.

## What it costs, and what it skips

A restore names every text-bearing block of the page, so the stored docs load
in ONE query (`editor-collab`'s `loadBlockDocs`) and the rows in another — never
one round trip per block. Two skips keep a large, mostly-unchanged page cheap,
and both use the one equality the channel applies everywhere (`sameRuns`:
coalesced and field-positional, so key order in a stored `jsonb` blob cannot
fake a difference):

- **A block with NO stored doc whose row already reads the target is left
  alone** — no seed, no row write. Its row is its seed: the first editor to
  open it seeds from `data.text`, which already says the target. Seeding it
  here would mint a doc for every never-opened block and change nothing.
- **A row that already reads the target is not rewritten**, whatever its doc
  needed.

## The seed race is closed by a return value

`initBlockDoc` is first-writer-wins **and returns the authoritative state**, so
the writer compares the bytes back with the bytes sent: same ⇒ it won and the
doc is correct; different ⇒ a browser seeded first, so continue down the edit
path against the winner's state. Nothing is merged blind.

The server's seed `clientID` mirrors `use-collab-block-doc.ts`'s FNV-1a
derivation over its OWN extension-set fingerprint — the token families that
contributed a server node, ids taken from the contributing plugin. Those ids are
not the web registrations' ids, so the fingerprint deliberately differs from a
browser's for the same runs, and that is the determinism contract working rather
than a gap: two seeds may share a clientID only when they are provably
byte-identical, and two independently-derived id sets are not a proof. The cost
is nil — `initBlockDoc` is first-writer-wins and hands back the authoritative
state, so a loser adopts the winner's bytes instead of merging its own.

A doc state loaded by the batched read may trail the table by the writes that
ran since (a browser flushing into the block). That costs nothing: the splice is
a Yjs delta over the loaded state's items, and `mergeBlockDocUpdate` MERGES it,
so the concurrent edit survives beside it.

## The character-level trim is the binding's own diff

`$spliceRunsInto` (`page/editor/core/runs-splice.ts`, called here from
`server/internal/block-doc-text.ts`) aligns the paragraph's leaf units (text /
line-break / link) and leaves the common prefix and suffix as the SAME nodes.
The motivating edit — one word in one paragraph — leaves one text unit on each
side, applied with a single `setTextContent`; `@lexical/yjs` then splices only
the changed span via its own `simpleDiffWithCursor`, i.e. the delta a human
typing it would have produced. A second character diff here would only give the
binding something to disagree with.

Everything else rebuilds just the middle through the SHARED `$appendRuns` walk.
A doc that is not a single paragraph — a shape nothing in this system produces —
is rebuilt wholesale: correct, not identity-preserving, stated not hidden.

## A doc holding an inline decorator node

`[[page:…]]` / `\(latex\)` / a bare `att-…` chip are plain characters in
`TextRun.text` — but in a doc a BROWSER wrote they are decorator NODES. The
server reads and rewrites them: a family declares its node once in its own
`core/` and contributes THAT object as `Editor.InlineToken`'s `node`, so
`blockTextServerNodes()` registers the headless twin of the class the browser
wrote the doc with and `blockTextServerExtensions()` serializes it back to its
token. Both are read at call time, like `blockTextProtectedSpans()`.

- **`readStateRuns` still refuses a decorator type with NO server node**, naming
  it (detected without hydrating: a decorator is the only thing `@lexical/yjs`
  stores as a `Y.XmlElement`). The refusal narrowed; it did not soften. **Do not
  "fix" the remainder with a stub class** — a node with no `getTextContent`
  serializes to `""` and the splice silently deletes the token.
- **`$spliceRunsInto` keys a registered token on its token TEXT**, and
  `newUnitsOf` mirrors `lineNodes`' split through the same `matchTokens`. An
  unchanged chip therefore aligns into the common prefix/suffix and keeps its
  CRDT item; one inside a changed middle re-materializes, because the rebuild
  gets the same extensions. The old unmatchable `opaque␀<nodeKey>` arm remains
  for an unregistered decorator and is unreachable — `readStateRuns` refuses
  first. Do not re-key a registered token on identity: every chip in an edited
  block would fall into the middle, survive as characters, and lose its node
  permanently (nothing re-scans an existing doc).
- Free consequence: any `edit_page` that rebuilds a block's middle materializes
  the chips in it — the migration path for legacy blocks, instead of a sweep.

## Tests

`server/internal/block-doc-text.test.ts` pins `readStateRuns` (pure, no DB).
`server/internal/write-block-texts.test.ts` drives `writeBlockTexts` against a
throwaway Postgres with the real migration chain (db-test-fixture), which needs
the running embedded cluster:

```bash
./equin test plugins/page/plugins/block-text-write
```

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Server-side text writes for a block's content doc — read a stored doc's true runs, splice it to target runs (or seed it first-writer-wins), then write the row's data.text projection: the one text channel every server-side content writer goes through.
- Server:
  - Uses:
    - `database.db`
    - `page/editor-collab.initBlockDoc`
    - `page/editor-collab.loadBlockDocs`
    - `page/editor-collab.mergeBlockDocUpdate`
    - `page/editor.applyPageBlockPatch`
    - `page/editor.blockTextServerExtensions`
    - `page/editor.blockTextServerNodes`
    - `page/editor.liveBlocks`
  - Exports (types): `BlockTextEdit`
  - Exports (values): `writeBlockTexts`
- Cross-plugin:
  - Imported by:
    - `apps/pages/history`
    - `page/markdown-apply`

<!-- AUTOGENERATED:END -->
