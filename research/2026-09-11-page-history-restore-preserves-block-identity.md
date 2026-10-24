# Page history restore keeps block identity (no hard delete of live content)

**Status:** design, ready to implement.
**Closes:** the follow-up in `research/2026-09-09-page-data-based-text-undo-entries-v2.md` §11
("History restore still hard-deletes content rows…").
**Amends:** `research/2026-06-16-global-page-version-history.md` (restore was
"delete + `insertForest`, fresh ids").

---

## 1. Context

Since 2026-09-09 every block delete a user makes is a **trash**: the row is
flagged, and its content doc (`page_block_docs`), side-table rows and links all
survive until purge. One path still really deletes live content: **history
restore.**

What restore does today (`replacePageContent`, `editor/server/internal/page-content.ts`):

1. It hard-`DELETE`s every live, non-page content row of the page
   (`deletePageContentRows`). Postgres cascades take each block's content doc
   with them, plus its TODO-task link, agent-note authorship and attachment
   links.
2. It re-inserts the version's blocks with **fresh ids** (`insertForest`). Each
   one re-seeds its doc from the version's `data.text`.

What the user loses:

- Blocks that existed now but not in the version are **gone for good**. The only
  way back is the pinned "Before restore" version, which rebuilds them as fresh
  ids from lagging `data.text`.
- Every block that survives the restore unchanged is still destroyed and
  rebuilt: new id, new doc (so the text's CRDT history is lost), and all its
  side-table links dropped.
- Open editors unmount every block and mount new ones.

**Outcome wanted.** Restore changes the page by **identity**:

- A block in both the current page and the version keeps its id and its doc. Its
  doc is *edited* to the version's text.
- A block deleted since the version comes back as **itself**, with its surviving
  doc byte-exact.
- A block created since the version is **trashed**, not deleted.

So undoing a restore (restoring "Before restore") brings those blocks back
byte-exact too. After this change, nothing the user can see is ever
hard-deleted outside purge.

### Decisions taken with the user

1. The writer bug below (§3) is fixed as **step 1 of this plan**.
2. **Sub-pages are never touched by a restore** — it never creates, revives or
   deletes one (today's behaviour, and it keeps a restore cleanly undoable). A
   content block that was trashed *together with* a sub-page comes back as a
   fresh-id copy of its text.
3. Snapshots keep storing `data.text`. They do not start reading docs. The
   version's own text can still trail its doc by the projection lag (≤ ~1 s).
   Accepted.

---

## 2. The approach in one paragraph

Restore becomes "make this page's forest equal to the version, **matching
blocks by id**", in three phases.

1. **Revive.** Bring back, via their trash entries, the version's blocks that
   were trashed from this page since.
2. **Structure.** Under the page lock, compute the target forest from the
   version plus what is live now, then write it with the op handler's own
   write shape (`writeForestTarget`: reconcile, park ranks, insert, update,
   trash).
3. **Text.** Edit each surviving block's doc to the version's text through the
   same server-side text writer `markdown-apply` uses. Then write the row's
   `data.text` projection.

This is the two-channel write order `markdown-apply` already follows (structure
first, then the doc, then the projection), now shared instead of duplicated.

---

## 3. Step 1 — the delete closure must follow the forest *as written* (live bug)

Found while designing this. Present on `main` since 3aa460cc3.

**The bug.** Both write shapes in `forest-writer.ts` compute the rows to trash
with `deleteClosureOf(before, deleteIds)`: the deleted ids plus every descendant
**in the pre-write forest**. When a write both moves a child out of a deleted
block and deletes that block, the child is counted as a descendant and trashed
anyway. The hard-delete era got this right for free, because the cascade ran at
`DELETE` time, after the moves.

Reachable today (verified by reading; the implementer confirms with a failing
test first):

- **`unwrap`** — Backspace at the start of a container's first child, or the
  rail's "Remove callout". `applyUnwrap` promotes the children, then removes the
  container. The server trashes the promoted children too.
- **`merge` with adoption** — Backspace-merging a block that has children. They
  are adopted by the target, then trashed.
- **`writeBlockPatch`** — redo of an unwrap, and a `markdown-apply` edit that
  removes a card but keeps its content.

The client overlay (`applyPatch`, the reducer) keeps those children, so the op
never confirms. The user sees them until a reload, and then they are gone. They
sit in a `page-blocks` trash entry with no UI.

**Fix.**

- **Closure over the as-written forest.** Close the delete set over the forest
  *as it will be written*: surviving rows carry their NEW `parentId`, removed
  rows keep their old one.
  - `writeForestTarget`: `after` ∪ the removed rows of `before`.
  - `writeBlockPatch`: `stored`, with each update/overwrite's named `parentId`
    applied, plus `inserts`.
  - A row the write re-homes can then never be trashed. An orphan a buggy
    reducer leaves behind still is — the closure remains the guarantee.
- **Trash before placing** (needed by §5.3's rank argument, and correct on its
  own). In both shapes, the inline trash branch (`trashDeletedRows`) runs
  **before** `parkRanks` / insert / update.
  - The live unique indexes are partial on `deleted_at IS NULL`, so a trashed
    row vacates its `(parent_id, rank)` slot. A survivor or insert can then land
    exactly where a row being deleted in the same write sat. Today that is a
    unique violation.
  - `parkRanks`' floor query still sees trashed ranks. Harmless: park keys only
    need to sit above the floor.
  - `writeBlockPatch` **refuses** (400) a patch that names one id both in a
    write bucket (create/update) and in `deleteIds`. Today the two are disjoint
    only by caller discipline (`handle-patch-blocks.ts` passes `deleteIds`
    through unchecked). `diffBlocks` never produces such a patch, and
    trash-first would otherwise write fields onto a row it just flagged.
  - The deferred (page-containing) branch still runs after the transaction, so
    it keeps the collision residual. A restore never takes that branch (§5.3).
- Update the `ForestWriteResult` / header comments and editor `CLAUDE.md`
  ("A patch's delete cascade reads POST-patch parentage" becomes true on the
  server again).

**Tests** (write them failing first):

- `page-forest.test.ts`, via the op handler:
  - unwrapping a two-child callout leaves both children live and trashes only
    the anchor;
  - a Backspace-merge that adopts children leaves them live.
- `handle-patch-blocks.test.ts`:
  - a patch that reparents a child out of a deleted parent keeps the child live;
  - a patch that deletes W at rank `m` and moves X to `m` under the same parent
    commits;
  - a patch naming one id in both `updates` and `deleteIds` is a 400.

---

## 4. Step 2 — one server-side text channel (lift out of `markdown-apply`)

The restore's text phase needs `writeBlockText`
(`markdown-apply/server/internal/block-doc-text.ts`). That function does four
things:

- reads a stored doc's true runs;
- splices only what changed (`$spliceRunsInto`);
- seeds a missing doc first-writer-wins;
- refuses a decorator it cannot read.

It can't live in `page/editor` (that would be a cycle: `editor-collab` imports
`editor`). It can't live in `editor-collab` either, whose barrel says
runs-aware exports breach its content-agnostic charter. And history should not
depend on the markdown engine to reach it.

**New plugin `plugins/page/plugins/block-text-write/`** (server barrel only):
"Server-side text writes for a block's content doc — the one text channel every
server-side content writer goes through."

- Moves in verbatim: `block-doc-text.ts` (`writeBlockText`, `readStateRuns`,
  seed helpers) and `block-doc-text.test.ts`.
- New export `writeBlockTexts(pageId, edits: readonly {blockId, runs}[])`:
  `markdown-apply`'s current steps 2a + 2b lifted as one function.
  - First, each block's doc through `writeBlockText`, wrapped in the same
    "structure is committed; re-running converges" error.
  - Then **one** projection patch through `applyPageBlockPatch`, whose update
    sets `data` to the row's data with `text` replaced (`projectedData` moves
    too).
  - The vanished-row check stays loud.
  - Perf, stated in the function: load every edited block's doc in **one**
    query rather than N. A block with **no stored doc whose row already reads
    the target runs** is skipped, because its row is already the seed and
    nothing will change it. That keeps a restore of a large, mostly-unchanged
    page from seeding hundreds of docs.
- `markdown-apply/server/internal/apply.ts` replaces its inline 2a/2b with
  `writeBlockTexts(pageId, textEdits)`. There is no behaviour change for it,
  except the skip above, which its idempotence already allows.
- `markdown-apply/CLAUDE.md` "The write order" / "The seed race" sections
  point at the new home. `block-text-write/CLAUDE.md` takes their prose.

---

## 5. Step 3 — `restorePageContent` (replaces `replacePageContent`)

`editor/server/internal/page-content.ts`, exported from the editor server
barrel.

```ts
export type BlockTextWriter = (
  pageId: string,
  edits: readonly { blockId: string; runs: RichText }[],
) => Promise<void>;

export async function restorePageContent(
  pageId: string,
  snapshot: PageContentSnapshot,
  io: { writeTexts: BlockTextWriter },   // required
): Promise<void>
```

**Why a required callback.** The editor cannot import the text writer (it would
be a cycle). A function that returned "text edits for the caller to apply"
would be a *you must also do X* coupling: forget it, and the restore silently
restores structure but not text. A required parameter makes forgetting a tsc
error. The editor still owns the whole ordering and the notify. The history
source passes `writeBlockTexts`.

### 5.1 Phase 0 — the page must be live

The page row is read from `liveBlocks`; a missing or trashed page is a `404`.
Today nothing checks this, and a revival (below) would `409` confusingly inside
`untrashBlocks`.

### 5.2 Phase 1 — revive (before the lock, like the patch handler's prelude)

For the version's **non-page** ids that are trashed rows with
`page_id = pageId` **in a `page-blocks` entry**, call `restoreEntryById` once
per distinct entry.

- **Whole entries only** — the ledger allows nothing else. An entry that also
  holds rows the version doesn't have brings them back too; phase 2 trashes
  them again (under the restore's own entry). The old entry is consumed, which
  is correct.
- **`pages` entries are never revived.** That would revive a sub-page
  (decision 2). A content row trashed with a sub-page is left for phase 2 to
  copy.
- The lookup is a raw read of trashed rows joined to `_trashEntries.sourceId`.
  It goes in `trash-blocks.ts` (already on the `no-unfiltered-blocks-read`
  allowlist) as `pageBlocksEntriesAmong(executor, pageId, ids)`. `page-content.ts`
  stays a `liveBlocks` reader.

### 5.3 Phase 2 — the target forest, written under the lock

`withPageForest([pageId, ...pageScopesOf(pageId)])` (same scopes as today: the
page's own shell sits in its parent's forest).

`before = (await ctx.forest()).map(rowToNode)`: every live row of this page,
revived rows included. Classify each version row under the lock:

| version row | state now | target |
|---|---|---|
| content | live here, content type | **survivor** — same id |
| content | no row with that id anywhere (purged) | **re-insert with the ORIGINAL id** |
| content | live on another page, trashed and not revived, or live here as a `page` shell (turned into a page since) | **fresh-id copy** (`newBlockId()`); its version children follow it through an id map |
| `page` shell | live here | **survivor**, moved to its version position |
| `page` shell | anything else | **dropped** — restore never mints a page partition (today's rule) |

"Exists anywhere" is one query over the version's unmatched ids:
`existingBlockIdsAmong(tx, ids)` in `forest-writer.ts` (allowlisted).

**Target nodes.**

- **Every target content row**: `pageId`, `parentId` (through the id map),
  `type`, `rank` and `expanded` come from the version.
- **A survivor's `data`** is the version's `data`, but its text is **not**
  written by the structural write:
  - When both the version's and the current `data` carry `text` (`hasTextKey`),
    the current `text` is kept — the structural write never changes an existing
    projection.
  - When the block turns from void back into text-bearing, the version's `text`
    is written (the biconditional needs one, and its doc may survive from an
    earlier text life).
  - Either way, **every text-bearing survivor gets a text edit**: the version's
    runs.
- **A re-inserted or copied row** carries the version's `data` including
  `text`. That row is the seed, so there is no text edit.
- **Live rows of this page not in the target** are removed (trashed). A shell
  is never removed.
- **A sub-page shell's `data` is always its CURRENT row's, never the
  version's.** The snapshot does record shell rows (title, cover), but writing
  them back would rename a live sub-page to its old title — the restore
  touching a sub-page, which decision 2 forbids. A shell's only possible
  changes are `parentId` and `rank`.
- **Live sub-page shells** stay put, following the markdown-apply idiom:
  - A shell in the version goes to its version `(parent, rank)` when that parent
    is in the target.
  - Otherwise it keeps its current `(parent, rank)`, provided that parent is in
    the target (or is the page) and no target row claims the same pair.
  - Otherwise it is re-homed to the page's top level, just above the highest
    target rank there.
- The page row's `data` is set from `snapshot.page` (`updateBlockFields`), as
  today.

**Write.** `writeForestTarget(ctx, before, after)`, the op handler's shape.

- The delete set is page-free by construction (shells are never removed). It is
  therefore trashed **inline**, under one `page-blocks` entry, and
  `deferredToChokepoint` is always false. Assert it rather than handle it.
- **Why the ranks can't collide.**
  - The target's `(parent, rank)` pairs are unique: they come from one valid
    version, plus shells placed by the rule above.
  - Every row being moved is parked (`pairChanged`).
  - Every row being deleted has already vacated its slot (§3's trash-first).
  - The one reachable collision today is this: nBetween is deterministic, so a
    block inserted where a since-deleted version block sat takes that block's
    exact rank. That is exactly the case §3 unblocks.
- A version row whose `data` no longer passes today's schema fails
  `parseBlockData` loudly, as `insertForest` did. That's unchanged.

**After commit** (outside the lock):

- `notifyStructuralChange({pageId, deletedRows})`;
- `notifyBlockChange({pageId, type: PAGE_BLOCK_TYPE, blockId: pageId})` for the
  page row's own data (title / cover), as today;
- `runOnTrash`, already queued by the writer.

### 5.4 Phase 3 — text

`await io.writeTexts(pageId, textEdits)`.

- Each survivor's doc is spliced to the version's runs. Only the changed middle
  is rebuilt, so unchanged spans keep their CRDT items, and marks and tokens
  survive.
- A revived block's doc is the one it had at deletion, edited only if the
  version's text differs.
- A failure throws with the "structure is committed; re-running the restore
  converges" message. Every phase is a pure function of current state, so a
  second restore finishes the job.

### 5.5 What open editors do (no client change)

- **Survivors stay mounted**; they have the same ids.
  - Structure arrives through the blocks push.
  - Text arrives as a `page-block-doc` push, which the provider applies under
    its own origin: a plain CRDT merge in the bound editor, with no rebind.
  - This is what `replacePageContent`'s old warning asked for ("…push a rebind
    signal instead"). The splice *is* the doc edit, so no bound doc is left
    holding pre-restore text.
- **A typing run open on a block the restore rewrites** is aborted and reported
  as `run-aborted`. Older undo entries on rewritten blocks replay with a
  `stale-entry` report. Both are the documented concurrency policy.
- **Revived and re-inserted ids** reach a tab that saw them before as
  `RowTruth === "removed"`. The editor never pre-seeds such a block: it binds to
  the surviving doc, or seeds on a `null` answer. This is the path built for
  undo-of-delete.
- **Trashed rows** vanish through the live filter. A pending flush into one
  succeeds into the trashed doc — the better outcome, because it is what
  undoing the restore brings back.

### 5.6 Deleted

- `replacePageContent` (renamed to `restorePageContent`; one caller).
- `insertForest`: its one caller goes. `planForestInsert` stays; it is paste's.
- `deletePageContentRows` (its one caller goes).

After this, `deleteBlockRoots` (a real `DELETE`) is reachable from purge alone,
so the "No hard delete of live content" header in `forest-writer.ts` loses its
exception.

---

## 6. Step 4 — history source

`apps/pages/plugins/history/server/internal/page-source.ts`:

```ts
restore: (pageId, snapshot) =>
  restorePageContent(pageId, snapshot as PageContentSnapshot, {
    writeTexts: writeBlockTexts,
  }),
```

It imports `writeBlockTexts` from `@plugins/page/plugins/block-text-write/server`.
The source comment changes from "the editor's replace emits… re-hydrate" to the
identity semantics. `web/internal/build-diff.ts`'s comment ("a post-restore
snapshot mints fresh ids") becomes history: the content fallback stays for
versions taken before this change.

---

## 7. Docs

- **editor `CLAUDE.md`**:
  - *Hardening › History restore*: rewritten to identity semantics, the three
    phases, and the sub-page rule.
  - *Every block delete is a trash (server)* and *A — atomicity*: drop "and in
    history restore's content wipe".
  - *Paste is an op*: drop the "`insertForest` is the HISTORY-RESTORE path"
    bullet.
  - *A write names the fields it changes*: the POST-patch parentage line is now
    true on the server.
- **`page-content.ts` / `forest-writer.ts` headers** — the invariant note on
  `replacePageContent` is replaced by the new contract.
- **`markdown-apply/CLAUDE.md`**: opening paragraph ("`replacePageContent`… fresh
  ids are load-bearing") is rewritten; the write-order / seed-race sections
  point at `block-text-write`.
- **Research docs**: supersession notes in
  `2026-06-16-global-page-version-history.md` and v2 §11.
- **Generated docs**: `docs/plugins-*.md` regenerate at build.

---

## 8. Tests

**Writer (step 1)** — see §3.

**`block-text-write`**: the moved `block-doc-text.test.ts`, plus
`writeBlockTexts`:

- a doc edit happens before the projection;
- one projection patch covers N edits;
- a no-doc block whose row already reads the target is skipped (no doc row is
  created);
- a no-doc block whose row differs is seeded, then projected.

**New `editor/server/internal/page-content.test.ts`** (`createTestDb` +
`runMigrations`, like `trash-blocks.test.ts`, with a recording stub
`writeTexts`):

- a survivor keeps its id, `created_at` and doc row (its bytes are untouched by
  phase 2);
- it moves to its version `(parent, rank)`;
- its text arrives only through the stub;
- a block created after the version is trashed under exactly one `page-blocks`
  entry, and its doc row still exists;
- a block deleted after the version is revived:
  - its entry is consumed;
  - it lands at its version rank **even though a block inserted after the
    deletion took that exact rank** (the deterministic-midpoint case);
  - its doc bytes are unchanged by phase 2;
- a revived entry holding a row the version lacks leaves that row trashed
  (under the restore's entry);
- a purged block is re-inserted with its original id and its `data.text` is the
  seed (no text edit);
- a version block now live on another page gives a fresh-id copy, with its
  children remapped, and the other page is untouched;
- a content row trashed with a sub-page (a `pages` entry) gives a fresh-id copy,
  and the sub-page stays trashed;
- sub-page shells:
  - a shell in the version returns to its version position, and keeps its
    current title (a sub-page renamed after the version is not renamed back);
  - a shell not in the version keeps its place, or is re-homed when its slot is
    claimed;
  - a trashed sub-page is not revived;
  - a shell turned from a version content block keeps its content, and the
    version block comes back as a copy;
- a survivor reparented out of a block that is being trashed stays live (§3);
- a trashed page gives a `404`;
- restoring twice converges (the second run changes nothing, and no second
  entry is minted);
- the ledger invariant holds at the end of every test.

**e2e `apps/pages/plugins/history/e2e/crdt-restore-verify.ts`** — flip:

- phase 6 becomes "restored row keeps its id";
- phase 8 becomes "the SAME doc row now reads V1, and its state contains the
  original client's items" (the doc grew; it was not replaced);
- phases 11–12 now probe a block created after v1: it is trashed, and a stale
  update does not resurrect it.

New phases:

- a block deleted after v1 comes back on restore with the same id, and its
  bytes contain its original items;
- restoring "Before restore" then revives the block that the first restore
  trashed, with **doc bytes identical** to before the first restore;
- an open editor on a surviving block shows V1 without remounting: the DOM node
  identity of its editable is kept across the restore.

---

## 9. Implementation sequence

Each step builds and passes `./equin check` on its own.

1. **Writer fix** (§3), failing tests first. Independent, and worth shipping on
   its own.
2. **`block-text-write`** lift plus `writeBlockTexts`; `markdown-apply` switches
   to it. No behaviour change.
3. **`restorePageContent`** (§5) with the two raw-read helpers, `page-content.test.ts`,
   and the deletions (§5.6).
4. **History source** switch (§6); flip and extend the e2e.
5. **Docs** (§7); `./equin build`.

---

## 10. Verification

```bash
./equin build
./equin check
./equin test plugins/page/plugins/editor
./equin test plugins/page/plugins/block-text-write
./equin test plugins/page/plugins/markdown-apply
./equin test plugins/page/plugins/annotations/plugins/agent-access
./equin run plugins/apps/plugins/pages/plugins/history/e2e/crdt-restore-verify.ts
./equin run plugins/page/plugins/editor/e2e/crdt-undo-verify.ts   # merge/unwrap undo still green
./equin run plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts
```

**Manual check** on the deployed worktree:

1. Type bold text into two blocks, wait about 10 s (one version), then delete
   one, add a new block, and edit the other.
2. Open Version history and restore the version. Expected: the deleted block is
   back with its bold, the new block is gone, and the edited block reverts. No
   block flickers or remounts.
3. With `query_db`, confirm:
   - the ids are unchanged;
   - the new block has `deleted_at` set and still has its `page_block_docs` row;
   - no `page_block_docs` row disappeared.
4. Restore "Before restore". The new block returns with the same doc bytes.
5. Also: Backspace-merge a block that has children, reload, and check the
   children are still there (step 1).
6. Debug → Reports shows no crash from any of it.

---

## 11. Out of scope (stated, not fixed here)

- **History engine atomicity.** "Before restore" is pinned in its own statement
  before the version lookup, so restoring a nonexistent version still pins one,
  and a crash between the pin and the restore leaves a pin with no restore.
  This is engine-level and pre-existing.
- **Snapshot text lags its doc by the projection window** (decision 3). A tab
  closed within ~1 s of typing leaves a row behind its doc until the block is
  next edited.
- **The deferred (page-containing) delete branch** keeps the rank-collision
  residual (§3). No restore reaches it.
- A decorator token with no server node makes that block's text phase throw
  (`readStateRuns`' refusal). It is loud, and a re-run after the token plugin
  gains a node converges.
