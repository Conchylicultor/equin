# Page undo: entries as data, and every block delete is a trash (v2)

**Status:** design, ready to implement.
**Supersedes:** `research/2026-09-09-page-data-based-text-undo-entries.md` (v1: the
entry model, splice hosts and run tracker — kept here with the corrections from
its review; its §6 client-side "staged seed" is dropped), and
`research/2026-07-07-page-per-block-crdt-plan-b.md` §Undo/redo.
**Amends:** `research/2026-07-11-global-trash-soft-delete-primitive.md` (page-free
delete sets are trashed too).

---

## 1. Context

On 2026-09-09 a user deleted a to-do block in a page, pressed Ctrl+Z, and got the
block back **without its text**. Two things went wrong, and they share one root.

- Text-undo entries on the tab's undo stack are **pointers**: each typing run is
  an item on the block's per-doc `Y.UndoManager`, and the stack entry is a thunk
  that pops that manager, guarded by "is this owner still live" — a **silent
  no-op** once the block's doc was destroyed (`collab-session.ts` `docEditThunks`).
  Structural entries, by contrast, are self-contained `BlockPatch` data and survive
  anything. The stack is unified in order but not in lifetime.
- A block delete is a **hard delete** unless the subtree contains a sub-page. The
  row's content doc (`page_block_docs`) cascades away; undo re-creates the row and
  the client **re-derives** a new doc from the ~1 s-lagged `data.text` projection.
  Under host load the re-seed raced to an empty seed, and first-writer-wins made
  the empty doc permanent. The trash primitive's own contract already says user
  content is never hard-deleted by a user action; this path violated it.

Decisions taken with the user:

1. Text entries become **data** (`{blockId, before, after}` runs). Replay means
   "make this block read these runs", through one splice with two hosts.
2. **Every block delete is a trash.** The content doc survives on the server, and
   undo restores the original doc byte-exact, across tabs and reloads.
3. Replay on a block another writer changed **applies and reports** (a
   `page-undo-conflict` report), never silently.
4. The silent no-op becomes inexpressible: the per-block `Y.UndoManager` and every
   thunk that pops it are deleted. Genuine replay failures throw and reach Reports.

Outcome: Ctrl+Z after undoing a delete reverts the typing; a deleted block comes
back with its exact doc (marks, tokens, unflushed keystrokes included); a block's
content is recoverable for 30 days after deletion.

---

## 2. Text entries as data

### 2.1 Entry shape and the one recorder

`block-editor-context.tsx` collapses `recordPatchEntry` / `recordStructural` /
`recordStructuralWithDocEdit` / `recordTextEdit` into one recorder (thin wrappers
keep the call sites readable):

```ts
interface BlockRunsEdit { blockId: string; before: RichText; after: RichText;
                          caretBefore?: number; caretAfter?: number }

function recordEntry(args: {
  label: string; focusId: string | null;
  before: Block[]; after: Block[];            // equal ⇒ pure text entry
  runsEdits?: readonly BlockRunsEdit[];
  coalesceKey?: string;
}): void
```

- Closes every open typing run first (§2.3), so a structural op never records
  ahead of the run that preceded it.
- For every row in `before` and not in `after`, pins `blockDocOwnerOf(id)?.runsNow()`
  onto that id's `create` in the **reverse** patch. This generalises merge's
  hand-passed `undoTextOverride`, which is deleted: a restored row's `data.text` is
  doc-exact (matters for history snapshots, search, backlinks and the seed of a
  block whose doc did not survive).
- Derives `{undoPatch, redoPatch}` via `derivePatchEntry` as today; bails only
  when the patches are empty **and** `runsEdits` is empty.
- `undo`: replay each `runsEdits[i].before` (§2.4), then `dispatchPatch(undoPatch)`.
  `redo`: `dispatchPatch(redoPatch)`, then replay `after` (with the confirmation
  gate of §2.4). Text before patch on undo, patch before text on redo — a doc
  edit runs while its row exists.
- `caretBefore/After` are recorded at run open/close (cheap data) and replay ends
  with `focusBlock(blockId, caret, {scroll: true})`. The binding treats a replay
  as a remote edit, so without the recorded caret the cursor would drift.

Add `runsEqual` to `core/rich-text.ts` (does not exist). `splitRuns` returns a
tuple: `const [head] = splitRuns(runs, position)`.

### 2.2 The splice, lifted once

`plugins/page/plugins/markdown-apply/server/internal/runs-splice.ts`
(`$spliceRunsInto(newRuns, extensions)`: mark/link/token-aware prefix-suffix
alignment, `setTextContent` fast path, rebuild of the changed middle only) moves
**verbatim** to `plugins/page/plugins/editor/core/runs-splice.ts`, exported from the
core barrel. Its imports (`lexical`, `@lexical/link`, `token-extension/core`,
editor core) equal `runs-lexical.ts`'s, so no barrel gains a dependency and no
cycle appears. `block-doc-text.ts` repoints one import. The test moves with it and
imports `runs-corpus.ts` directly (the mirrored corpus is deleted).

### 2.3 The run tracker on `BlockDocOwner` (replaces the `Y.UndoManager`)

`collab-session.ts`:

- `runsNow(): DocSourcedRuns` — `projectableRunsOf(doc)` memoized on a `gen`
  bumped in `doc.on("update")`. `flushProjection` (`use-collab-block-doc.ts`)
  reads it too. The brand is preserved (the memo stores what the sole producer
  produced). Cost: one headless read per run boundary and per projection flush,
  shared when they land on the same generation. Not cheaper than today in every
  case (a >1 s typing burst reads twice); acceptable.
- Origins reaching the canonical doc are exactly three: the provider (server
  applies, seeds), the replay origin (§2.4), and the binding via the relay (every
  Lexical edit, typing and surgery alike; the relay passes origins verbatim).
  `isLocalEdit(origin) = origin !== provider && origin !== TEXT_REPLAY_ORIGIN`,
  **stated**, not learned.
- `doc.on("beforeTransaction")`: if local and no run is open, open one with
  `before = runsNow()` (a memo hit on the common path; `encodeStateAsUpdate`
  performs no transaction, and `readYDoc` hydrates a separate replica, so no
  re-entrancy on the source doc).
- `doc.on("update", (_, origin))`: bump `gen`; local ⇒ re-arm the 500 ms idle
  timer; non-local mid-run ⇒ **abort** the run and emit a `run-aborted` conflict
  report (§6). An echo of the client's own flush produces no `update` event, so
  it cannot trip this.
- `closeRun()`: idempotent; `after = runsNow()`; emit `BlockRunsEdit` to
  subscribers when `after` differs from `before`. `closeAllOpenTextRuns()` iterates
  the registry.
- **`untracked(edit)`** — the suppression scope the review showed is required:
  closes any open run, runs `edit` with local transactions ignored, never emits.
  Every caller that records its own `runsEdits` runs its surgery inside it: the
  split's `truncateAt`, merge's `appendRunsAtEnd`, and `recordDocEdit`'s edit.
  Without it each of these binding-origin transactions would open a run and
  double-record on top of the structural entry (one Ctrl+Z would then restore the
  origin's full text while the split tail still exists).
- Because the scope wraps the real Yjs transaction, the transaction must land
  synchronously inside it. A nested `editor.update` from a Lexical command handler
  is enqueued past the scope, so the **split keeps its `queueMicrotask`** around
  the truncation and records in that microtask; `recordDocEdit` moves the microtask
  inside itself (both current callers drop theirs).
- The `binding-replica.ts` module comment on the `UndoManager` origin contract is
  rewritten; `CollaborationPlugin`'s own replica-side manager keeps accumulating
  items and never replays (its commands are swallowed) — pre-existing, unchanged.

### 2.4 Replay: one entry point, two hosts, a confirmation gate

New `web/internal/block-text-write.ts` (host A) and
`web/internal/block-text-write-stored.ts` (host B, the one with `fetchEndpoint`,
kept apart so the bun suite imports only A):

- **Host A, open doc:** `spliceOpenBlockDoc(owner, runs)` =
  `editYDocState(encodeStateAsUpdate(owner.doc), () => $spliceRunsInto(runs, ext))`
  → `applyUpdate(owner.doc, delta, TEXT_REPLAY_ORIGIN)`. Verified: the relay
  forwards the Symbol origin, `@lexical/yjs` renders it as a collaboration
  change, the provider queues it for flush, the tracker ignores it.
- **Host B, stored doc:** `spliceStoredBlockDoc(blockId, seedRuns, runs)` =
  `doc-init` (authoritative state; seeds from the pinned `data.text` only when no
  doc exists) → headless splice → `doc-update`. `runs` is `(current: RichText) =>
  RichText` so a **forward** write stays relative to the authoritative content
  (the unmounted merge appends onto what the server holds, never onto a lagged
  row). Replaces `appendRunsToBlockDoc` and the position-based
  `truncateBlockDocFrom`; the un-append is a splice whose prefix alignment removes
  exactly the appended suffix.
- **`applyBlockRuns({blockId, runs, expected, …})`** picks the host:

  | state of the block | host |
  |---|---|
  | live owner whose doc holds content (synced, or a locally-authoritative pre-seeded doc) | A — its updates queue until sync exactly like typing into a fresh split block |
  | live owner, doc **empty** and not synced (existing block mid-hydration) | wait for the owner's `sync`, then A |
  | no owner, row in `serverIds` | B |
  | no owner, row **not** in `serverIds` (just re-created optimistically) | wait, push-based, for the `serverIds` transition that already drives `markBlockRowConfirmed`; if an owner appears meanwhile, A; else B |
  | memory mode (`persist={false}`, tests only) | write `data.text` |

  Never `doc-init` a row the server may not have: the review showed v1's "not
  synced ⇒ host B" arm 404s on a fast redo of a re-created block (the e2e only
  passed because of a 600 ms sleep between steps).
- `expected` (the entry's `after` on undo, `before` on redo) is compared to the
  current runs; a mismatch means a second writer — apply anyway, report
  `stale-entry` (§6).
- Failures throw `BlockTextReplayError` (cause attached). `useUndoRedo` runs
  thunks as a floating promise, so the rejection is unhandled and the crash
  collector files a `browser-rejection` report today. No new report kind for the
  failure path; only `UndoRedoThunkError`'s message must append the cause.

### 2.5 The undo-redo primitive: pending flush and serialization

`plugins/primitives/plugins/undo-redo/web`:

- `registerPendingFlush(fn)`: `undo()`/`redo()` run every registered flush
  synchronously before popping. The page editor registers
  `closeAllOpenTextRuns`, so a Ctrl+Z 200 ms into a typing run undoes that run,
  not the entry below it.
- **Serialize** `undo`/`redo`: a call while a thunk is in flight queues behind it.
  Today `replaying` is a boolean held across `await thunk()` and `record` silently
  returns while it is true — a flush during an in-flight host-B replay would drop
  the run's entry. Serialization closes that and keeps LIFO ordering against
  in-flight stored-doc writes.
- `UndoRedoThunkError` message includes the cause's message.

### 2.6 Split, merge, autoformat as data entries

- **Split** (`block-editor-context.tsx` ~1719-1800): `before = owner.runsNow()`
  (not the row when `opts.runs` is absent), `after = head`; forward truncation
  inside `untracked` in the microtask; one entry with the structural patch. The
  Enter-at-offset-0 branch edits no doc and records no `runsEdits`.
- **Merge**: `targetBefore` = the target's authoritative runs (owner `runsNow()`,
  or the runs host B read from the server), `targetAfter = mergeRuns(targetBefore,
  mergingRuns)`. Mounted target: `appendRunsAtEnd` inside `untracked` (it places
  the caret at the join). Unmounted target: host B with a relative `runs`
  function. The source row comes back through the reverse patch with pinned
  runs and its **surviving** doc (§4).
- **`recordDocEdit`** (inline-markdown autoformat, unmark): defers internally,
  `untracked(edit)` between two `runsNow()` reads, records one text entry.

### 2.7 What is deleted

`collab-session.ts`: `UndoManager` import, `um`, `UNDO_CAPTURE_TIMEOUT_MS`, the
tracked-origin learner, the `stack-item-added` mirror, `capturing`,
`captureEdit`, `docEditThunks`, `CapturedBlockDocEdit`, `captureBlockDocEdit`.
`use-collab-block-doc.ts`: `appendRunsToBlockDoc`, `truncateBlockDocFrom`, the
thunk-typed `onUndoableEdit` parameter (the run-tracker subscription keeps the
name with a data payload). `block-editor-context.tsx`: the four recorders,
`undoTextOverride`. `keyboard-plugin.tsx` / `inline-markdown-plugin.tsx`: their
`queueMicrotask` wrappers. `isLive` stays (finalize uses it); the replay guard
goes. Acceptance grep: `rg 'docEditThunks|CapturedBlockDocEdit|captureBlockDocEdit|undoTextOverride|appendRunsToBlockDoc|truncateBlockDocFrom' plugins` returns nothing.

Pointers deliberately kept: `blockDocOwnerOf(id)` at record time is a *capture*,
not a reference the entry holds; entries stay `useScopedUndoRedo`-scoped (their
patch thunks close over the page's optimistic store — making them mount-free is a
follow-up); `appendRunsAtEnd` for the forward merge only.

---

## 3. Every block delete is a trash (server)

### 3.1 Policy

- **P1** Every delete of page-block rows is a trash. `deleteBlockRoots` (real
  `DELETE`) is reachable only from purge and from history restore's
  `deletePageContentRows` (out of scope, §9).
- **P2** Entry partition: unchanged for page roots (one `pages` entry per page
  root); every other row of the operation goes under **one anchor entry per
  operation** — folded into the page entry when one exists, otherwise minted in a
  new source **`page-blocks`**. One gesture = one undo; the Pages Trash dialog
  subscribes to the `pages` source only, so block entries can never appear there.
- **P3** Ledger invariant, by construction: an entry exists ⇔ at least one row
  carries its id. Flags are set only by `trashBlockRoots` in the same tx as
  `recordTrashEntry`; cleared only by `untrashBlocks(entry)`, which deletes its
  ledger row inside its own tx. A DB `CHECK ((deleted_at IS NULL) = (trash_entry_id IS NULL))`
  on `page_blocks` backs it (migration via `./equin build`).
- **P4** A patch `create` whose id matches **any** trashed row restores that row's
  whole entry through `untrashBlocks` before the write tx (today's page-shell path,
  generalised); restored ids are excluded from every write bucket. The
  `untrashes` bucket in `writeBlockPatch` (which left entries dangling) is
  deleted. `untrashBlocks` keeps the stored row, repairs a taken `(parent_id,
  rank)` with `rankAdjacentTo(…, occupant, "after")` from the rank barrel, and
  reparents to the workspace root if the parent is gone — restore never fails on a
  slot collision.
- **P5** Hot path stays one transaction: a page-free set is trashed **inline** in
  the write tx (`trashDeletedRows` in `forest-writer.ts`: `recordTrashEntry` +
  `trashBlockRoots` + `afterCommit(runOnTrash)`); the `deferredPageDelete` gate
  stays but its non-deferred branch flips from hard delete to inline trash.
  Page-containing sets stay deferred to `deleteBlocksSubtree` (other pages' locks).
- **P6** `page-blocks` entry: `rootEntityId` = first root, `label` = first line of
  the first root's text (≤ 80 chars, else `"N blocks"`), `meta = {pageId, rootIds,
  count}`. No UI in this pass (undo + purge only).
- **P7** `DeleteBlocksOutcome` = `{trashed: true; entries: {sourceId; entryId}[]} |
  {trashed: false}` (`false` only when nothing existed); `handleDeleteBlock`
  returns the right source id. Deleting an already-trashed id is a 404.
- **Invariant for the client (state in `editor/CLAUDE.md`):** trash never touches
  `page_block_docs`; `doc-init` on a trashed or restored row returns the
  **surviving** state and `doc-update` merges into it (verified: FK satisfied while
  soft-deleted). A client that pre-seeds a restored row from `data.text` and then
  merges the surviving doc duplicates the paragraph — hence §4.

### 3.2 Files

- `editor/core/schemas.ts`: `PAGE_BLOCKS_TRASH_SOURCE = "page-blocks"`.
- `editor/server/internal/tables.ts`: the CHECK.
- `document-hooks.ts`: `onTrash(rows)` / `onRestore(rows)` take rows, not ids;
  `runOnTrash`/`runOnRestore` move beside `runOnDelete` in `forest-writer.ts`.
- `forest-writer.ts`: `trashDeletedRows`; both gates flip; `untrashes` removed;
  `ForestWriteResult.trashedEntryId`; header: "no hard delete of live content".
- `trash-blocks.ts`: load live rows only; unconditional anchor entry; `entries`
  outcome; `untrashBlocks` consumes its entry, repairs rank, returns `restoredIds`,
  runs `onRestore`; new batched `purgeTrashedBlocks(entries)` (one subtree
  collect, one lock, one tx) for the `page-blocks` source; `restoreEntryById`
  helper so the patch handler stops naming the ledger table.
- `server/index.ts`: second `defineTrashSource({id: PAGE_BLOCKS_TRASH_SOURCE,
  restore: untrashBlocks, purge: purgeTrashedBlocks})`.
- `handle-patch-blocks.ts`: generalised un-trash prelude (dedupe by
  `trashEntryId`, `restoreEntryById`, exclude restored ids); redo's `deleteIds`
  with non-page ids now trash through the flipped branch — no further change.
- `handle-delete-block.ts`, `handle-update-block.ts`, `handle-turn-into-page.ts`,
  `handle-move-block.ts`, `handle-list-blocks.ts`: trashed ids are not addressable
  (`isNull(deletedAt)` + 404).
- Hook contributors: `content-search` and `links` delete-hooks filter page rows in
  memory (their `pageIdsAmong` DB reads go); page deindex / outgoing-edge delete at
  trash, reindex at restore, purge idempotent; content-block derived state
  re-derives through `blocksChanged` subscribers, all already live-filtered.
  `history` unchanged (per page, dies at purge). Attachment links of a trashed
  block are untouched by reconcile, so the orphan sweep keeps the file — add the
  test. `inline-date`: verify `reconcileReminders` revives a `canceled` reminder
  whose token reappears on restore (flagged guess; fix there if not).
- Purge/TTL: one 30-day TTL for both sources (two TTLs on one table are not
  expressible today: duplicate job name and duplicate growth bound both throw).
  Volume on main: ~1.8k rows created per 30 days, so a comparable trashed set and
  ~2 MB of retained docs; no new index.
- `trash/CLAUDE.md` and `TrashOutcome`'s doc: a source may consume its entry
  inside `restore`; the "page-free subtree records nothing" paragraph goes.

### 3.3 Reader enforcement (rung 2 + 3)

New `editor/server/internal/live-blocks.ts`:
`liveBlocks = new QueryBuilder().select().from(_blocks).where(isNull(_blocks.deletedAt)).as("live_blocks")`
— a typed subquery readers `.from(liveBlocks)`; the predicate cannot be forgotten
because it is never written. Postgres flattens it, and the rendered SQL still names
`page_blocks`, so the live-state read-set extractor and change-feed invalidation
keep working (a DB view would not match the base table — rejected). Export beside
`_blocks`; verify the `rank_text` decoder survives the alias.

New lint rule `editor/lint/no-unfiltered-blocks-read.ts` (shape of
`no-adhoc-forest-write.ts`): `.from(_blocks)` only in an allowlist
(`forest-writer.ts`, `trash-blocks.ts`, `collect-subtree.ts`, `page-forest.ts`,
`page-id.ts`, `handle-patch-blocks.ts`). Migrate every filtered reader
(`resources.ts`, `forest.ts`, `page-content.ts`, `handle-get-block-page`,
`markdown-apply` read, `inline-date`, `attachment-block`, `links`,
`content-search`, `agent-origin`) to `liveBlocks`, dropping their `isNull` terms.
Mechanical; its own commit.

---

## 4. The client binds a restored row to its surviving doc

The provider today infers "no doc can exist" from "row not confirmed"
(`live-state-yjs-provider.ts` `connect()` pre-seed branch). Trash falsifies that:
an optimistically re-created row is unconfirmed and its doc survives. Cold
(never observed in this tab, or > 5 min TanStack gcTime) that pre-seed lands
before the subscription answers and the surviving doc merges as a second
paragraph.

**Rule (rung 1, derive the fact):** the one thing that licenses an instant
`data.text` pre-seed is *this client has never seen this block id in server
truth*.

```ts
export type RowTruth = "unseen" | "present" | "removed";
```

- `block-editor-context.tsx`: a monotonic `everServerIds` grown from every
  `store.serverData` push; `rowTruthOf(id)` = present if in `serverIds`, else
  removed if in `everServerIds`, else unseen. `collab-text-plugin.tsx` passes it
  instead of `rowConfirmed`; `useCollabBlockDoc` gates `markBlockRowConfirmed` on
  `"present"`; `CollabSession.start` sets `locallyAuthoritative = !serverSync ||
  rowTruth === "unseen"`.
- `LiveStateYjsProvider`: `blockRowConfirmed = rowTruth === "present"` (FK gate
  unchanged) and `mayHaveStoredDoc = rowTruth !== "unseen"`; the pre-seed condition
  becomes `!mayHaveStoredDoc && serverState === undefined && clients.size === 0`.
  Refinement: in `ingestServerState`, a `"removed"` block whose subscription
  answers **`null`** pre-applies the (pinned, doc-exact) seed at that moment, so a
  restored never-opened block renders after one round trip instead of two.
- Not a `restore` flag on the patch op (a second spelling chosen per call site,
  and it misses redo-of-split-undo and paste routes); not strict-null everywhere
  (the instant split path would render an empty root for a round trip).
- v1's staged-seed registry, `dispatchOverlay` funnel and 4 MB LRU are **deleted**:
  the server doc is the staged seed, durable and shared. §2.1's pinning stays.
- A flush racing the delete now succeeds into the trashed doc (the better
  outcome: it is what undo restores). The provider's 409 path remains only for
  purge and the "doc row vanished" anomaly; comments that say "the FK cascade
  dropped the row" are rewritten. Replay on a row another tab trashed applies
  (doc-init returns the surviving doc); only purge → 404 → throw.

| scenario | truth | outcome |
|---|---|---|
| delete → undo, opened, warm | removed | no pre-seed; cached state applied at `connect()`; instant |
| same, cold | removed | skeleton for one round trip, then the surviving doc; same as any cold open |
| delete → undo, never opened | removed | subscription answers `null` → pinned seed pre-applied, doc-init on confirmation |
| split | unseen | unchanged instant pre-seed |
| split → undo → redo | removed (tail confirmed) / unseen | surviving tail doc via subscription / instant seed, nothing to collide with |
| undo, typing before the server answers | removed | `hydrating`, flushes held; the arriving state aborts the open run (§6) |
| two tabs | A removed, B present | both bind to the one surviving doc, neither seeds |
| unflushed bytes at delete | — | owner retained; same owner reused |

**Hard ordering constraint:** §4 must land **before or with** §3. The server
change alone makes a cold delete→undo duplicate text, because today's FK cascade
is exactly what keeps the current pre-seed safe.

---

## 5. Concurrency policy

- **Stale entry:** replay compares the block's current runs to `expected`; under
  single-writer LIFO they always match, so a mismatch is a genuine second writer.
  Apply, report `stale-entry`. Residual documented in `editor/CLAUDE.md` with the
  upgrade path (runs-level 3-way merge).
- **Remote apply mid-run:** abort the open run, report `run-aborted`; one lost undo
  step at a genuinely concurrent moment, never a destructive entry. Also covers
  the hydration window.
- **Block gone at replay:** a text entry's host B gets 404 only after purge →
  `BlockTextReplayError` → crash report. A structural entry's reverse patch
  restores the row (and, now, its doc) before its `runsEdits` run.

---

## 6. The conflict report

Producer `editor/web/internal/undo-conflict-report.ts`:
`undoConflictReportSink = defineReportSink<{reason: "stale-entry" | "run-aborted";
blockId; direction: "undo" | "redo" | null; expectedLength; actualLength}>()`.
Consumer `plugins/reports/plugins/page-undo-conflict/` mirroring
`reports/plugins/collab-hydration` (core schema + fingerprint over the reason
only, web `Core.Root` collector + `KindView`, server `ReportKind` + `renderTask`).
The editor never imports `reports`.

---

## 7. Tests

**Move:** `runs-splice.test.ts` → `editor/core` (direct `runs-corpus` import).

**New, bun (`editor/web/internal/*.test.ts`):** run boundaries on a real
`Y.Doc` (one edit per idle window, `before`/`after` exact); marks and tokens
survive capture → replay; a provider-origin apply mid-run aborts and emits;
`spliceOpenBlockDoc` is minimal (unchanged units keep their item clocks); the
replay origin opens no run; **a run opened from inside a relayed binding
transaction** (headless editor + `createBinding` + `BindingReplica`) — the nested
`editor.update` path v1's tests never exercised; `untracked(edit)` emits nothing.

**New, jsdom (`editor/web/__tests__/`):** the incident — type, delete, undo,
undo reverts the typing (no silent no-op); `RowTruth` derivation; provider:
`removed` + pending subscription never pre-seeds and applies the later state
exactly once (paragraph count 1, no doc-init); `removed` warm path; `unseen`
still pre-seeds and doc-inits byte-identically; `removed` + `null` + confirmation
posts exactly one seed; host B on a `hydrating` restored block converges; the
undo-redo primitive: a pending flush's `record` lands while a thunk is in flight
(serialization). `structural-undo.test.tsx`: lift the merge exclusion (offscreen
merge is one `applyBlockRuns` with two stubbed endpoints); the pin (restored row
carries the doc's runs).

**New, server (`createTestDb` + `runMigrations`, like `doc-store.test.ts`):**
`trash-blocks.test.ts` flips "page-free stays hard" → one `page-blocks` entry, docs
intact, `OnTrash` rows, no `OnDelete`; `handle-patch-blocks.test.ts` (give
`applyPageBlockPatch` an executor parameter): create-same-id un-trashes and
consumes the entry, `created_at` unchanged, docs byte-identical; redo re-trashes
under a new entry; mixed page + paragraph bulk delete; `purgeTrashedBlocks`
cascades docs and attachment links, idempotent; rank slot taken → restore ranks
after the occupant; deleting a trashed id → 404; the CHECK rejects a flag without
an entry; ledger-consistency assertion at the end of every test; attachment
orphan sweep keeps a trashed block's file; inline-date reminder revives on
restore; `page-forest.test.ts` delete case now expects inline trash; lint rule
tests for `no-unfiltered-blocks-read` and `no-adhoc-doc-write`.

**e2e (`./equin run …`):** `crdt-undo-verify.ts` phase 2 flips
(`"P2 redo B-typing restores 'bravo'"` — the headline); phase 4 asserts byte
identity of the merged-away source doc; new phases: type bold, delete, Ctrl+Z,
Ctrl+Z (mark intact, exactly one paragraph); doc bytes before delete == after
restore; Ctrl+Z inside the 500 ms idle window undoes the just-typed run; a fast
Ctrl+Shift+Z pair (no sleep) on a re-created block. New
`trash-block-doc-verify.ts`: doc-init returns the same bytes while trashed and
after restore; a never-focused block deleted with its container and undone keeps
its text.

---

## 8. Docs

`editor/CLAUDE.md` §"CRDT text on the ONE unified undo stack" rewritten (data
entries, hosts, tracker, `RowTruth`, the absolute-vs-CRDT trade, the server
invariant of §3.1); §"Inline markdown autoformat", §"Projection + content-doc-aware
split/merge" and the un-trash bullet updated; `collab-session.ts`,
`live-state-yjs-provider.ts` and `binding-replica.ts` module comments;
`editor-collab/server/internal/tables.ts` ("rows die with their block" → at
purge); `trash/CLAUDE.md`; `markdown-apply/CLAUDE.md`; `undo-redo` barrel
description and CLAUDE (pending flush, serialization); supersession notes on the
two research docs named in the header; `docs/plugins-*.md` regenerate at build.

---

## 9. Implementation sequence

Each step builds and passes `./equin check` on its own.

1. Lift the splice into `editor/core` (+ test de-mirror). No behaviour change.
2. `runsNow()` memo on `BlockDocOwner`; projection reads it. No behaviour change.
3. **`RowTruth`** (`everServerIds`, `rowTruthOf`, provider `mayHaveStoredDoc`, the
   `null`-answer refinement) and the doc-exact **pinning** in `derivePatchEntry`.
   Ship early; independent of the entry model.
4. **Server trash** (§3.1–3.2): constant, CHECK, hook signatures,
   `trashDeletedRows`, chokepoint, second source, patch prelude, 404s, contributor
   hooks, reminder check, tests, `./equin build` (inspect the generated
   migration SQL). *Must follow step 3.*
5. `liveBlocks` + `no-unfiltered-blocks-read` + reader migration.
6. `undo-redo`: `registerPendingFlush`, serialization, error message.
7. Hosts A/B and `applyBlockRuns` with the confirmation gate (unused yet).
8. Run tracker + `untracked` **alongside** the `Y.UndoManager`, on a second
   channel; a temporary test asserts the two agree on run counts.
9. Switch the entries: `recordEntry`; split/merge/`recordDocEdit` as data; delete
   the pointer machinery (§2.7).
10. Conflict detection, the sink, `reports/plugins/page-undo-conflict`.
11. Lint `no-adhoc-doc-write` (only `block-text-write.ts` may `applyUpdate` onto
    an owner's doc).
12. Tests and docs; flip the e2e phase-2 assertion last as the acceptance gate.

---

## 10. Verification

```bash
./equin build                                   # migration for the CHECK, registries, docs
./equin check                                   # boundaries, doc sync, lint incl. the two new rules
./equin test plugins/page/plugins/editor
./equin test plugins/page/plugins/markdown-apply
./equin test plugins/page/plugins/editor-collab
./equin test plugins/infra/plugins/trash
./equin test plugins/primitives/plugins/undo-redo
./equin run plugins/page/plugins/editor/e2e/crdt-undo-verify.ts
./equin run plugins/page/plugins/editor/e2e/trash-block-doc-verify.ts
```

Manual: on the deployed worktree, in a page: type bold text into a block, delete
the block, Ctrl+Z (block back with bold), Ctrl+Z (typing reverted); query
`page_block_docs` for the id via `query_db` before and after and compare bytes;
check Debug → Reports shows no `page-undo-conflict` or crash from the flow.
Acceptance grep from §2.7.

---

## 11. Follow-ups (filed as tasks, not in scope)

- ~~History restore (`deletePageContentRows`) still hard-deletes content rows and
  re-seeds from the snapshot's `data.text` — same class of bug; its net is the
  pinned "Before restore" version.~~ Done 2026-09-11: restore keeps block
  identity and trashes instead of deleting —
  [`2026-09-11-page-history-restore-preserves-block-identity.md`](2026-09-11-page-history-restore-preserves-block-identity.md).
- Per-source trash TTL (`defineTrashSource({ttlDays})`, one sweep looping sources).
- A "Deleted blocks" trash UI over the `page-blocks` source (must be windowed).
- Mount-free undo entries (route patches through `enqueueResourceWrite`) so
  entries survive page navigation.

## 12. Guesses to verify while implementing

- Warm-path ordering: the subscription effect runs before `CollaborationPlugin`'s
  `connect()` (the provider holds either order safely; only instant-vs-one-commit
  differs).
- drizzle `check()` at the pinned version, and `QueryBuilder…as()` preserving the
  `rank_text` decoder.
- `reconcileReminders` on a `canceled` row whose token reappears.
- Client confirmation of a restore whose rank was repaired server-side is causal
  (the page-shell restore relies on it today).
- `textOf` vs `plainOf` as the entry-label reader.
- Module-eval cleanliness of `endpoints/web` under bun (kept out of the bun suite
  by the host split).
