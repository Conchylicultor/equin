# Data-based text-undo entries for the page editor

**Status:** design, ready to implement.
**Supersedes:** `research/2026-07-07-page-per-block-crdt-plan-b.md` §Undo/redo (the
thunk-over-`Y.UndoManager` model, whose "open question — verify cross-block
merge-undo rebinding" is the defect this closes).
**Related:** `research/2026-08-03-page-block-content-session-one-owner.md` (R3 —
why the owner registry exists; this plan keeps the owner and removes the *undo*
reason for it).

---

## 1. The defect, in one paragraph

A block's prose lives in a per-block `Y.Doc`. Text-undo entries on the app's
single undo stack are **pointers** into that doc's `Y.UndoManager`
(`docEditThunks`, `plugins/page/plugins/editor/web/internal/collab-session.ts:512`).
Deleting a block hard-deletes its row, the `page_block_docs` row cascades away
(`plugins/page/plugins/editor-collab/server/internal/tables.ts`), the editor
unmounts, the owner finalizes and the doc is destroyed. Every earlier text entry
for that block now points at a dead manager, and `isLive` turns each one into a
**silent no-op** (`collab-session.ts:505-518`). Undoing the delete recreates the
row from the patch and mints a *new* doc, re-derived from `data.text` — a
~1 s-debounced, lossy stand-in for the doc. Yesterday a user lost a block's text
this way.

The root cause is not the delete. It is that an undo entry references a **live
object** whose lifetime nobody promised. This plan removes the reference.

---

## 2. The shape of the fix

Three changes, in dependency order:

1. **Every text-undo entry becomes DATA** — `{ blockId, before: RichText, after:
   RichText }`. Replay means "make this block's content read exactly these runs",
   applied through ONE splice primitive with two hosts (an open `Y.Doc`, or the
   stored doc on the server).
2. **Every write that removes a row stages that block's content-doc bytes**, and
   the block's next owner is constructed *with those bytes as its seed*. The
   restored doc is the original doc, not a re-derivation.
3. **The pointer machinery is deleted**: the per-block `Y.UndoManager`,
   `docEditThunks`, `captureEdit`/`capturing`, `captureBlockDocEdit`,
   `CapturedBlockDocEdit`, `onUndoableEdit`, `undoTextOverride`,
   `appendRunsToBlockDoc`, `truncateBlockDocFrom`. `isLive`-guarded replay stops
   existing because there is nothing left to guard.

The trade this makes, deliberately and once: an entry stops being *CRDT-correct
under concurrency* (a `Y.UndoManager` reverses exactly the items one client's run
created, leaving a concurrent writer's characters alone) and becomes *absolute*
(the block is made to read `before`). That is unavoidable — CRDT item ids are
meaningless after the doc is destroyed and recreated, which is precisely the case
we must survive. §9 states the resulting concurrency policy and how it is
detected and reported.

---

## 3. The splice primitive and its two hosts

### 3.1 Lift `$spliceRunsInto` into `editor/core`

`plugins/page/plugins/markdown-apply/server/internal/runs-splice.ts` already *is*
the primitive: mark-, link- and token-aware minimal alignment on leaf units, a
`setTextContent` fast path that lets `@lexical/yjs` produce a human-shaped delta,
and a general path that rebuilds only the changed middle through `$appendRuns`.
It imports `lexical`, `@lexical/link`, `token-extension/core` and
`@plugins/page/plugins/editor/core` — no Node APIs.

**Move it verbatim** to `plugins/page/plugins/editor/core/runs-splice.ts` and
export `$spliceRunsInto` from `plugins/page/plugins/editor/core/index.ts`.

- `editor/core/runs-lexical.ts` already imports exactly the same three externals,
  so this adds no dependency to the core barrel.
- `markdown-apply/server/internal/block-doc-text.ts` changes one import (it
  already imports the editor core barrel). `runs-splice.ts` is deleted from
  markdown-apply.
- **No new cross-plugin edge, no cycle.** `editor/core` imports nothing from
  `editor/web`, `editor/server`, `editor-collab` or `markdown-apply`.
- Bonus: the co-located suite moves to
  `plugins/page/plugins/editor/core/runs-splice.test.ts` and can finally import
  `editor/core/runs-corpus.ts` **directly** instead of mirroring it (the mirror
  exists only because a cross-plugin deep path is illegal — see the test's own
  header). ~90 lines of duplicated corpus deleted.

### 3.2 Host A — an open doc (the block has a live `BlockDocOwner`)

New: `plugins/page/plugins/editor/web/internal/block-text-write.ts`.

```ts
/** Origin stamped on a replay so the run tracker does not mistake it for typing. */
export const TEXT_REPLAY_ORIGIN = Symbol("page.editor.text-replay");

/** Make an OPEN block doc read exactly `runs`. Synchronous. */
export function spliceOpenBlockDoc(owner: BlockDocOwner, runs: RichText): void {
  const { extensions, nodes } = blockTextRunsOptions();
  const delta = editYDocState(
    encodeStateAsUpdate(owner.doc),
    () => $spliceRunsInto(runs, extensions),
    { nodes: [LinkNode, ...nodes] },
  );
  applyUpdate(owner.doc, delta, TEXT_REPLAY_ORIGIN);
}
```

Why headless-against-the-canonical-doc rather than driving the mounted Lexical
editor through a new `BlockTextSurgery.setRuns`:

- **One host covers "the doc is open", mounted or not.** An owner can outlive its
  binding (retention window, a block inside a collapsed container whose editor
  unmounted while the owner is still held). A binding-shaped verb would need a
  third arm.
- The `applyUpdate` fans out exactly like a remote edit: the `BindingReplica`
  relay passes the origin verbatim
  (`plugins/page/plugins/editor/web/internal/binding-replica.ts:33-48`), the
  binding's own `origin !== binding` check lets `syncYjsChangesToLexical` render
  it, and the provider queues it for flush because
  `LiveStateYjsProvider.onDocUpdate` forwards every origin that is not the
  provider (`live-state-yjs-provider.ts:533`).
- It is transport-agnostic: identical on `LocalYjsProvider` (`persist={false}`).

Cost is one `encodeStateAsUpdate` + one headless Lexical hydration of **one
block's paragraph**, on a user gesture. The caret is restored by the entry's own
`focusBlock`, as today.

### 3.3 Host B — the stored doc (no live owner)

Same file. This is `appendRunsToBlockDoc`'s three-step shape with the append
replaced by the splice, and it **replaces both** `appendRunsToBlockDoc` and
`truncateBlockDocFrom` (`use-collab-block-doc.ts:987`, `:1034`).

```ts
/** Make a block's STORED doc read exactly `runs`. Throws loudly on failure. */
export async function spliceStoredBlockDoc(
  blockId: string, seedRuns: RichText, runs: RichText,
): Promise<void> {
  const { state } = await fetchEndpoint(blockDocInit, { id: blockId },
    { body: new Blob([buildSeedStateFor(seedRuns)]) });          // authoritative
  const update = editYDocState(base64ToBytes(state),
    () => $spliceRunsInto(runs, extensions), { nodes: [LinkNode, ...nodes] });
  await fetchEndpoint(blockDocUpdate, { id: blockId }, { body: new Blob([update]) });
}
```

`truncateBlockDocFrom`'s documented FRAGILITY (a positional cut that a concurrent
append past the offset would silently swallow) **disappears**: the write is no
longer position-relative, it is a whole-content splice against the authoritative
state read in the same call.

### 3.4 The one entry point

```ts
/**
 * Make block `blockId` read `runs`. `expected` is what the caller believes the
 * block currently holds; a mismatch is reported (§9) but does not stop the write.
 */
export async function applyBlockRuns(args: {
  blockId: string; runs: RichText; expected: RichText;
  serverSync: boolean; rowRuns: RichText;      // the row's data.text, the seed fallback
  writeRow: (runs: RichText) => void;          // memory-mode fallback (§3.5)
}): Promise<void>
```

Arms, in order:

| condition | host | why |
|---|---|---|
| live owner **and** `provider.isSynced` | A (open doc) | authoritative locally |
| live owner, **not** synced, `serverSync` | B (stored doc) | a local splice would fight the not-yet-arrived server state and duplicate; the server write converges back through `blockContentResource` |
| no owner, `serverSync` | B | the block has no editor (collapsed container) |
| no owner, **not** `serverSync` (memory mode) | `writeRow` | there is no doc and no server; `data.text` *is* the content, and the block's doc seeds from it on mount |

The `serverSync` discriminator is already on the block-editor context
(`block-editor-context.tsx`, read by `collab-text-plugin.tsx:421`) — no new prop.

### 3.5 Loud failure

`spliceStoredBlockDoc` throws on any `EndpointError` — including the 404 that
`doc-init` returns for a block row that is gone at replay time. Wrap it:

```ts
export class BlockTextReplayError extends Error {
  constructor(readonly blockId: string, cause: unknown) { super(`page: could not replay text for block ${blockId}`, { cause }); }
}
```

That propagates out of the entry's `undo`/`redo`, is wrapped by
`UndoRedoThunkError` (`plugins/primitives/plugins/undo-redo/web/internal/store.ts:40`),
and reaches Reports today: `useUndoRedo` runs the thunk as `void runGuarded(...)`,
so the rejection is unhandled and `CrashCollector`'s `unhandledrejection` listener
(`plugins/reports/plugins/crash/web/components/crash-collector.tsx:26`) files a
`kind: "crash"`, `source: "browser-rejection"` report. **No new report kind is
needed for the failure path.**

One small primitive fix so the report is diagnosable: `UndoRedoThunkError`'s
message today is only `"undo-redo: undo thunk threw"` and the cause never reaches
the report's `message`/`stack`. Append it:

```ts
super(`undo-redo: ${direction} thunk threw: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
```

---

## 4. Capturing typing runs as data

The `Y.UndoManager`'s `captureTimeout` did the grouping. Its replacement lives on
`BlockDocOwner`, which already owns the doc, the transport and the fan-out
listeners.

### 4.1 The memoized doc read (a net win, not a new cost)

Reading runs off a doc is `projectableRunsOf(doc)` → `xmlTextToRuns` → a headless
Lexical hydration (`web/internal/doc-sourced-runs.ts:64`). Per keystroke that is
unaffordable; per run boundary it is fine.

Add to `BlockDocOwner`:

```ts
private gen = 0;                                   // bumped in doc.on("update")
private runsMemo: { gen: number; runs: DocSourcedRuns } | null = null;
/** The doc's runs, memoized on the doc's update generation. */
runsNow(): DocSourcedRuns { … }
```

`flushProjection` (`use-collab-block-doc.ts`) switches from
`projectableRunsOf(owner.doc)` to `owner.runsNow()`. The `DocSourcedRuns` brand is
preserved (the memo returns what the sole producer produced), so the projection's
provenance guarantee is untouched.

**Net effect on typing cost:** today one uncached read per `PROJECT_DEBOUNCE_MS`
(1 s). After: one read per run boundary (~500 ms idle), shared with the projection
whenever they land on the same generation — which, during a pause, they always do.
Steady-state typing gets *cheaper*, not dearer.

### 4.2 The run tracker

```ts
const TEXT_RUN_IDLE_MS = 500;   // was UNDO_CAPTURE_TIMEOUT_MS

private openRun: { before: RichText } | null = null;
private runTimer: Timeout | null = null;
private readonly runListeners = new Set<(edit: BlockRunsEdit) => void>();
```

Wiring in the constructor (replacing the tracked-origin learning listener):

- `doc.on("beforeTransaction", tr)` — if `isLocalEdit(tr.origin)` and no run is
  open, open one with `before = this.runsNow()`. `encodeStateAsUpdate` performs no
  transaction of its own (`yjs` `encodeStateAsUpdateV2` is a pure read of
  `doc.store`), so reading here is safe and yields the **pre**-transaction state.
  On the common path this is a memo hit — nothing changed since the previous run
  closed.
- `doc.on("update", (_u, origin))` — bump `gen`. If `isLocalEdit(origin)`, re-arm
  the idle timer. If **not** local (a server apply landing mid-run), **abort** the
  open run (§9.2).
- `closeRun()` — idempotent: clear the timer, read `after = this.runsNow()`, and
  if it differs from `before`, emit `{ blockId, before, after }` to every listener.

`isLocalEdit(origin)` = `origin !== this.provider && origin !== TEXT_REPLAY_ORIGIN`.
That is the whole origin discipline, and it is now *stated* rather than learned:
the two non-local sources are named, instead of "anything that is not the provider
and not an `UndoManager`".

`onUndoableEdit(cb)` keeps its name and its subscriber
(`collab-text-plugin.tsx`'s `useUndoableEditRecorder` → `recordTextEdit`), but its
payload changes from `CapturedBlockDocEdit` (thunks) to `BlockRunsEdit` (data).

### 4.3 Closing a run before the stack is read

An open run has not been recorded yet, so a Cmd+Z while it is open would undo the
*previous* entry and leave the just-typed characters standing. (Today this works
by accident: the manager's stack item exists after the run's first transaction and
grows.)

The fix belongs in the primitive, because the primitive owns the moment the stack
is read. Add to `plugins/primitives/plugins/undo-redo/web`:

```ts
/**
 * Seal an in-progress batch into an entry before the stack is read. A producer
 * that COALESCES many small edits into one entry (a typing run) has, between the
 * first edit and the coalescing deadline, an entry that exists but has not been
 * recorded. `undo()`/`redo()` run every registered flush synchronously before
 * popping, so the stack a user acts on is always complete.
 */
registerPendingFlush(fn: () => void): () => void;
```

Implementation: a `Set<() => void>` alongside the scoped store; `undo()`/`redo()`
iterate it *before* `popUndo`/`popRedo` (and outside the `replaying` guard, so the
flush's `record` lands normally). The page editor registers one flush that calls
`closeAllOpenTextRuns()` — a module function in `collab-session.ts` iterating the
owner registry.

This is rung 1 for the class: an in-progress batch becomes unobservable to the
stack, rather than something every trigger site has to remember to flush.

The recorder (§5) also calls `closeAllOpenTextRuns()` at its top, so a structural
op is never recorded ahead of a typing run that preceded it.

---

## 5. One recorder, one entry shape

`recordPatchEntry`, `recordStructural`, `recordStructuralWithDocEdit`,
`recordTextEdit` and `recordDocEdit` collapse into **one** recorder plus thin
wrappers. `derivePatchEntry`'s `undoTextOverride` parameter is deleted (§6).

```ts
interface BlockRunsEdit { blockId: string; before: RichText; after: RichText }

function recordEntry(args: {
  label: string;
  focusId: string | null;
  /** Row snapshots. Equal arrays ⇒ a pure text entry (empty patches). */
  before: Block[]; after: Block[];
  /** Content-doc changes this op made, as data. */
  runsEdits?: readonly BlockRunsEdit[];
  coalesceKey?: string;
  caretOffset?: number;
}): void
```

It:

1. `closeAllOpenTextRuns()`.
2. For every id in `before` and not in `after`, calls `preserveDoc(id)` (§7) and
   pins the returned runs onto that block's `create` in the **reverse** patch.
   This is `undoTextOverride`, generalised and derived — no caller passes it.
3. Derives `{ undoPatch, redoPatch, undoFocus, redoFocus }` exactly as today.
4. Bails only when the patches are empty **and** `runsEdits` is empty.
5. Records:

```ts
undo: async () => {
  for (const e of runsEdits) await applyBlockRuns({ blockId: e.blockId, runs: e.before, expected: e.after, … });
  dispatchPatch(undoPatch);            // stages docs for the rows it deletes (§7)
  if (undoFocus) queueMicrotask(() => focusBlock(undoFocus, undefined, { scroll: true }));
},
redo: async () => {
  dispatchPatch(redoPatch);
  for (const e of runsEdits) await applyBlockRuns({ blockId: e.blockId, runs: e.after, expected: e.before, … });
  if (redoFocus) queueMicrotask(() => focusBlock(redoFocus, undefined, { scroll: true }));
},
```

Text-first on undo, patch-first on redo — the same ordering the combined entry
keeps today, for the same reason (a doc edit must run while its row exists).

### The three call shapes

- **Structural op** (`dispatchOp`, `commitRows`): `runsEdits` omitted.
- **Text edit** (the tracker's `onUndoableEdit`): `before === after === rowsRef.current`,
  `runsEdits: [edit]`, `focusId: blockId`. No `coalesceKey` — the tracker already
  grouped the run (same reasoning as today, minus the LIFO-correspondence
  argument, which no longer exists to break).
- **Split / merge**: both, in one entry (§8).

### `recordDocEdit` — the trap removed

Today: `recordDocEdit(blockId, label, edit)` runs `edit` inside
`captureBlockDocEdit`'s fence, and **every caller must wrap it in
`queueMicrotask` itself** because a Lexical command handler runs inside
`editor._updating` and a nested `discrete` update is enqueued past the capture
window. Both callers do (`keyboard-plugin.tsx:229`,
`inline-markdown-plugin.tsx:132`), and a third would silently double-record.

New:

```ts
const recordDocEdit = (blockId: string, label: string, edit: () => void) => {
  // Deferred INTERNALLY: this is the only correct way to call it from a Lexical
  // command handler or update listener, so the deferral is not the caller's to
  // remember. (Callers already re-verify their plan against live state.)
  queueMicrotask(() => {
    const owner = blockDocOwnerOf(blockId);
    if (!owner) { edit(); return; }        // no doc — nothing to record
    owner.closeRun();                       // fence off the preceding typing run
    const before = owner.runsNow();
    edit();                                 // synchronous (surgery uses discrete: true)
    const after = owner.runsNow();
    owner.closeRun();                       // fence off the following typing run
    if (runsEqual(before, after)) return;
    recordEntry({ label, focusId: blockId, before: rows, after: rows,
                  runsEdits: [{ blockId, before, after }] });
  });
};
```

Both call sites drop their own `queueMicrotask`. Rung 1: the "you must defer a
microtask" coupling has no spelling left.

---

## 6. Delete-undo: the doc bytes and the seed handoff

### 6.1 Staging, at the one door to the store

Every removal of a row must preserve that block's doc, in **either** direction —
deleting a block, and undoing a split (whose reverse patch deletes the new block,
whose doc is the split tail and worth keeping).

Funnel every `store.dispatch` in `block-editor-context.tsx` through one helper.
Today there are four direct call sites (`dispatchPatch`, `dispatchOp`,
`applyOverlay`, merge's mounted branch); after this there are two doors and both
stage:

```ts
/** THE door to the store. Preserves the content doc of every row this write removes. */
const dispatchOverlay = useCallback((v: BlockOverlayOp, removedIds: readonly string[]) => {
  for (const id of removedIds) preserveDoc(id);
  store.dispatch(v);
}, [store]);

const dispatchPatch = (patch: BlockPatch) =>
  isEmptyPatch(patch) || dispatchOverlay(buildPatchOverlayOp(patch), patch.deleteIds);
```

`patch.deleteIds` already covers the whole cascade set (the patch is derived from
`diffBlocks(before, after)` and `after` lacks every descendant). Op dispatches pass
`removedBetween(before, after)`.

```ts
/** Capture a block's live content doc before its row goes away. Returns the doc's
 *  runs (the exact `data.text` the restored row must carry), or null when the
 *  block has no live doc — the fallback arm. */
function preserveDoc(blockId: string): RichText | null {
  const owner = blockDocOwnerOf(blockId);
  if (!owner) return null;
  stageBlockDocSeed(blockId, encodeStateAsUpdate(owner.doc));
  return owner.runsNow();
}
```

`recordEntry` calls it too (step 2 of §5), immediately before the dispatch, in the
same task. Both calls see the same doc; staging is idempotent (last write wins).

### 6.2 The handoff — the block's next owner *is* seeded with the bytes

In `collab-session.ts`:

```ts
/** Content-doc bytes staged for a block whose row is about to vanish, consumed by
 *  that block's NEXT owner as its seed. Bounded LRU by total bytes. */
const stagedSeeds = new Map<string, Uint8Array>();
export function stageBlockDocSeed(blockId: string, state: Uint8Array): void
```

`BlockDocOwner`'s constructor **takes** (not peeks) the staged entry and prefers it:

```ts
private readonly restoredSeed = stagedSeeds.get(blockId) ?? null;   // and delete
// handed to the provider as:
() => this.restoredSeed ?? buildSeedState()
```

Taking at **owner construction**, not at every `buildSeedState()` call, is what
makes the entry self-expiring: exactly one owner consumes it, and a later remount
of the same block correctly falls back to `data.text` (which the projection has
re-derived from the restored doc by then). A peek-forever map would hand a stale
seed to a memory-mode remount of a long-lived block.

The sequence after Cmd+Z on a delete:

1. `preserveDoc` already staged the bytes (at delete time).
2. The undo's reverse patch re-creates the row **optimistically**. `serverIds`
   does not yet contain it, so the block renders with `rowConfirmed === false`.
3. The block's editor mounts → `CollabSession.start` → a new `BlockDocOwner` takes
   the staged seed.
4. `LiveStateYjsProvider.connect()` hits the pre-seed branch
   (`!blockRowConfirmed && serverState == null && doc.store.clients.size === 0`,
   `live-state-yjs-provider.ts:322`) and applies the **captured bytes** instantly —
   the user sees their real text immediately, marks and tokens included.
5. The confirming blocks push flips `rowConfirmed` → `markBlockRowConfirmed` →
   `doc-init` posts the captured bytes → first-writer-wins recreates
   `page_block_docs` from the original doc.

**The deterministic-`clientID` seed contract is not weakened, it is bypassed.**
Captured bytes carry the original doc's real clientIDs. Two tabs that both undo
the same delete stage byte-equivalent states of the *same* items, so whichever
`doc-init` wins, the loser's apply of the authoritative state is a CRDT no-op
merge — convergence by item identity rather than by encoding determinism, which is
strictly stronger than the `data.text`-seed path.

### 6.3 The fallback arm, and why it is now exact

A block with no live doc this session (never opened) has nothing staged; it seeds
from `data.text` exactly as today. And a block that *had* a live doc gets its
reverse-patch `create` pinned to `owner.runsNow()` (§5 step 2) — the doc's true
runs at delete time, not the ≤1 s-lagged projection. So even the worst case
(undo, then navigate away before the row confirms) restores **content-exact** text.

This is what deletes `undoTextOverride`: merge's hand-passed pin becomes a derived
property of every removal.

### 6.4 Memory bound

`stagedSeeds` is capped by total bytes (4 MB) with oldest-first eviction. An
evicted entry degrades to the pinned-exact `data.text` seed, so eviction is a
fidelity loss (CRDT identity) and never a content loss. Documented, not reported.

---

## 7. Split and merge as data entries

### 7.1 Split (`block-editor-context.tsx:1719-1800`)

The origin's doc-side change is **already known as data** — no capture needed:

```ts
const runs = opts?.runs ?? …;                 // live runs, captured pre-split
const { head } = splitRuns(runs, position);   // core/rich-text.ts
recordEntry({ label: OP_LABELS.split, focusId: newId, before, after,
              runsEdits: [{ blockId, before: runs, after: head }] });
```

The forward truncation still runs through the mounted editor
(`authority.surgeryOf(blockId)?.truncateAt?.(position)`) because it must place no
caret and must not disturb the new block's landing. But the **record no longer
waits on it**: `queueMicrotask` around `captureBlockDocEdit` disappears, and with
it the "a nested `editor.update` escapes the capture window" hazard. The
Enter-at-start branch is unchanged (it edits no doc, hence no `runsEdits`).

### 7.2 Merge (`block-editor-context.tsx:1469-1590`)

One implementation for both branches, because the doc side is now the same data
either way:

```ts
const mergingRuns = runs ?? runsOfNode(block);
const targetBefore = blockDocOwnerOf(target.id)?.runsNow() ?? runsOfNode(target);
const targetAfter  = mergeRuns(targetBefore, mergingRuns);   // core/rich-text.ts:229
```

- **Mounted target:** keep `appendRunsAtEnd(mergingRuns)` as the forward apply —
  it lands the caret at the join, which no data model can do. Record
  `runsEdits: [{ blockId: target.id, before: targetBefore, after: targetAfter }]`.
  The `captureBlockDocEdit` wrapper is gone; the microtask deferral stays (it is
  about the keydown, not about a capture window).
- **Unmounted target:** the forward apply becomes
  `applyBlockRuns({ blockId: target.id, runs: targetAfter, expected: targetBefore, … })`,
  and the entry is the same. `appendRunsToBlockDoc` and its `joinOffset` return
  disappear.

**The un-append is a runs splice.** Undo applies `targetBefore` to the target
through `$spliceRunsInto`, whose prefix alignment recognises every leaf unit of
`targetBefore` as an unchanged prefix and removes exactly the appended suffix
units — the minimal delta, and never a positional cut. `truncateBlockDocFrom` and
its FRAGILITY note are deleted.

The source block's row is restored by the reverse patch with pinned exact runs,
and its doc from the bytes `preserveDoc` staged. Merge stops being a special case.

---

## 8. What gets deleted

`plugins/page/plugins/editor/web/internal/collab-session.ts`
- `import { UndoManager } from "yjs"`, `owner.um`, `UNDO_CAPTURE_TIMEOUT_MS`
- the dynamic tracked-origin `beforeTransaction` listener and the
  `stack-item-added` mirror
- `private capturing`, `captureEdit()`, `docEditThunks()`
- `interface CapturedBlockDocEdit`, `captureBlockDocEdit()`
- the module comment's undo paragraphs
- `isLive` **stays** — `finalize()` uses it; only the replay guard goes.

`plugins/page/plugins/editor/web/internal/use-collab-block-doc.ts`
- `appendRunsToBlockDoc`, `truncateBlockDocFrom`
- the `onUndoableEdit` parameter of both hooks and its observer in
  `useDocObservers` (replaced by the run-tracker subscription of the same name)
- `$truncateFromLinearOffset` import (the function itself stays in
  `collab-text-surgery.ts` for the live split truncation)

`plugins/page/plugins/editor/web/block-editor-context.tsx`
- `recordStructuralWithDocEdit`, `recordPatchEntry`, `recordStructural`,
  `recordTextEdit` → one `recordEntry` + wrappers
- `undoTextOverride` on `derivePatchEntry` and its pinning block
- the `CapturedBlockDocEdit` / `captureBlockDocEdit` imports
- three of the four direct `store.dispatch` call sites (funnel into
  `dispatchOverlay`)
- `BlockEditorAPI.recordTextEdit`'s signature changes (`CapturedBlockDocEdit` →
  `BlockRunsEdit`); `recordDocEdit`'s stays but its contract loses the
  "defer a microtask yourself" clause

`plugins/page/plugins/editor/web/components/collab-text-plugin.tsx`
- `useUndoableEditRecorder`'s payload type only; the wiring shape is unchanged.

`plugins/page/plugins/editor/web/components/keyboard-plugin.tsx`,
`components/inline-markdown-plugin.tsx`
- their own `queueMicrotask` wrappers around `recordDocEdit`.

`plugins/page/plugins/markdown-apply/server/internal/runs-splice.ts` and its test
— moved, not deleted.

### Pointers deliberately kept

1. **`blockDocOwnerOf(blockId)` at record/dispatch time.** Reading a live doc
   (bytes, runs) is a *capture*, not a reference held by the entry. The entry that
   results holds only data. Called out because the brief asks.
2. **The entries are still `useScopedUndoRedo`-scoped** (dropped on editor
   unmount). Their thunks close over the page's optimistic store and the caret
   authority, which genuinely die with the mount. Making them mount-free would
   need every patch to go out through `enqueueResourceWrite` — a separate change,
   not required by this one. (It would then be worth doing: the *text* half is now
   already mount-free.)
3. **`appendRunsAtEnd` on `BlockTextSurgery`.** Kept for the forward merge only,
   because it places the caret at the join. Its undo no longer uses it.

---

## 9. Concurrency, edge cases, policy

### 9.1 A remote edit between record and replay

An absolute entry that says "make it read `before`" will discard a concurrent
writer's change to the same block. Detection is exact and cheap: the entry knows
what it believes the block currently holds (`after` for undo, `before` for redo).
`applyBlockRuns` reads the current runs and compares.

Under single-writer LIFO the comparison always matches: later entries for the same
block are popped first, so by the time an entry is reached the block reads its
`after` exactly. **A mismatch therefore means a genuine second writer** — another
tab, or an agent through `markdown-apply`'s `writeBlockText`.

Policy: **apply, and report.** The user asked to undo; refusing would leave the
entry popped and the stack wrong, and a three-way runs merge is out of scope for
this change. The report is what turns an invisible clobber into a measurable one
(§10). The residual is documented in `editor/CLAUDE.md` with the upgrade path
(runs-level 3-way merge, or entries anchored on Yjs relative positions for the
subset of blocks whose doc was never destroyed).

### 9.2 A remote apply lands mid-run

The open run's `before` was read before the remote content existed, so closing the
run would record an entry whose undo wipes the remote change. The tracker
**aborts** the open run instead (drops it, re-opens on the next local
transaction) and emits the same conflict report with `reason: "run-aborted"`.
Cost: one lost undo step at a genuinely concurrent moment. Correct over
destructive.

This also covers the hydration window: a user typing into a block whose server
state has not arrived opens a run against an empty doc; the arriving state aborts
it, and the next run's `before` is the merged content.

### 9.3 The block is unmounted at replay time

Handled by §3.4's arms: a collapsed-container block has no owner, so the write
goes to the stored doc. Nothing silently no-ops.

### 9.4 The block row is gone at replay time

Another tab deleted it, or a page was trashed. A **text** entry's
`spliceStoredBlockDoc` gets a 404 from `doc-init` and throws
`BlockTextReplayError` → crash report (§3.5). A **structural** entry's reverse
patch re-creates the row, so its `runsEdits` run against a row that exists.

### 9.5 Two tabs

Both stage their own captured bytes on delete; both propose them at `doc-init`;
first-writer-wins and the loser's apply is a no-op merge over identical items
(§6.2). Typing runs in the other tab surface as §9.2 aborts here.

### 9.6 Undo of a delete whose block never remounts

The staged seed is never taken; the row's `data.text` (pinned exact) is the
content, and the next open seeds from it. Content-exact, CRDT identity lost.

### 9.7 Redo → undo cycles

`dispatchOverlay` re-stages on every removal, in either direction, so a
delete/undo/redo/undo cycle restores the doc every time.

---

## 10. The conflict report

The failure path already reaches Reports (§3.5). The **clobber** path does not,
because it is not an exception. Add it with the collab-hydration recipe.

**Producer** — `plugins/page/plugins/editor/web/internal/undo-conflict-report.ts`:

```ts
export type UndoConflictReason =
  /** A replay found the block holding something other than what the entry recorded. */
  | "stale-entry"
  /** A remote apply landed inside an open typing run; the run was dropped. */
  | "run-aborted";

export interface UndoConflictReport {
  reason: UndoConflictReason;
  blockId: string;
  direction: "undo" | "redo" | null;
  expectedLength: number;   // plain length the entry believed
  actualLength: number;     // plain length found
}
export const undoConflictReportSink = defineReportSink<UndoConflictReport>();
```

**Consumer** — `plugins/reports/plugins/page-undo-conflict/` mirroring
`plugins/reports/plugins/collab-hydration/` exactly: `core/` (payload zod schema +
`sha256("page-undo-conflict|" + reason).slice(0,16)` fingerprint — the reason
only; block ids and lengths are per-occurrence), `web/` (a `Core.Root` collector
registering the sink + a `KindView`), `server/` (the `ReportKind` + `renderTask`).

The page editor must not import `reports`, hence the sink inversion — same as
`collabHydrationReportSink`.

---

## 11. Boundary and cycle check

| new edge | legal? |
|---|---|
| `editor/core` → `lexical`, `@lexical/link`, `token-extension/core` | already present via `runs-lexical.ts` |
| `markdown-apply/server` → `editor/core` (`$spliceRunsInto`) | already present |
| `editor/web` → `editor-collab/core`, `collab-doc/core` | already present (`use-collab-block-doc.ts`) |
| `editor/web` → `optimistic-mutation/web` | already present (via `block-store.ts`) |
| `reports/plugins/page-undo-conflict/web` → `editor/web` | same shape as `reports/plugins/collab-hydration/web` |
| `undo-redo/web` barrel gains `registerPendingFlush` | additive, own barrel |

No plugin gains a dependency it did not already have; no cycle is created.
`./equin check plugin-boundaries` and `plugins-doc-in-sync` should pass with
only the regenerated doc block changing.

A new lint rule is worth adding while the funnel is fresh —
`plugins/page/plugins/editor/lint/no-adhoc-doc-write.ts`, in the shape of the
existing `no-adhoc-structural-write`: ban `applyUpdate(` on a value derived from
`blockDocOwnerOf(...).doc` outside `web/internal/block-text-write.ts`. That keeps
"there is exactly one writer of a block's content doc from the app side" at rung 3
rather than in prose.

---

## 12. Tests

### Move / adapt

- `markdown-apply/server/internal/runs-splice.test.ts` →
  `plugins/page/plugins/editor/core/runs-splice.test.ts`, importing
  `./runs-corpus` directly and deleting the mirrored corpus. `bun:test`,
  co-located — matches `test-layout:runner-split`.
- `markdown-apply/server/internal/block-doc-text.test.ts` — import path only.

### New

`plugins/page/plugins/editor/web/internal/block-text-runs.test.ts` (`bun:test`,
headless — no DOM needed; `editYDocState` runs under bun today on the server):

1. **Run boundaries.** Drive a real `Y.Doc` seeded with `runsToXmlText`; apply
   local transactions; assert exactly one `BlockRunsEdit` per idle window, with
   `before` = pre-run runs and `after` = post-run runs.
2. **Marks and tokens survive** a capture/replay round trip (bold run, link run,
   a synthetic token family through `defineInlineTokenNode`).
3. **A provider-origin apply mid-run aborts the run** and emits a conflict body.
4. **`spliceOpenBlockDoc` is minimal**: after replaying a one-word change, the
   unchanged units keep their Yjs item ids (compare `toDelta()` item clocks).
5. **The replay origin does not open a run** (no entry recorded for a replay).

`plugins/page/plugins/editor/web/__tests__/delete-undo-doc-restore.test.tsx`
(jsdom) — **the yesterday regression**:

6. Type into a block (one run recorded) → delete the block → undo the delete →
   undo again. The typing entry must actually revert the text, not silently
   no-op. Asserted through the block's staged-seed doc, since Lexical is not
   mounted in this harness.
7. `stageBlockDocSeed` is populated on delete and **taken** by the next owner:
   `CollabSession.start` for the same id yields a provider whose seed bytes equal
   the captured ones.
8. A second remount of the same block falls back to `data.text` (the seed was
   consumed exactly once).

### Extend

- `structural-undo.test.tsx`: its "merge/mergeNext deliberately EXCLUDED" caveat
  can be **lifted** — with `appendRunsToBlockDoc` gone, the offscreen merge is one
  `applyBlockRuns` and only needs `blockDocInit`/`blockDocUpdate` stubbed. Add the
  quadruple assertion for both.
- `collab-session.test.ts`: the run tracker's lifetime — a run open when the
  session ends is closed (and recorded) before teardown.

### e2e — `plugins/page/plugins/editor/e2e/crdt-undo-verify.ts`

- **Phase 2 flips.** `"P2 redo B-typing = documented no-op"` (lines 178-184)
  becomes `"P2 redo B-typing restores 'bravo'"`. That single assertion is the
  headline outcome of this plan.
- **New phase 6 — the incident.** Type into a block, delete it, Cmd+Z (row back),
  Cmd+Z (typing reverted). Assert the text is the pre-typing value, and that it
  came back with a **mark** intact (type bold text, so a plain-text-only restore
  would fail).
- **New phase 7 — CRDT identity.** After delete → undo, fetch
  `page_block_docs` for the block and assert the doc holds the original items
  (a second client in the existing phase-5 context still converges without
  duplication).
- **New phase 8 — undo mid-run.** Type, and press Cmd+Z **before** the 500 ms
  idle window closes; the just-typed run must be what is undone (pins §4.3).

Run: `./equin test plugins/page/plugins/editor`,
`./equin test plugins/page/plugins/markdown-apply`,
`./equin run plugins/page/plugins/editor/e2e/crdt-undo-verify.ts`.

---

## 13. Docs to update

- `plugins/page/plugins/editor/CLAUDE.md` §"CRDT text on the ONE unified undo
  stack" (line 2646) — **rewritten**: entries are data; the two hosts; the run
  tracker; the staged-seed handoff; the absolute-vs-CRDT trade and its concurrency
  policy. The "Known degradations" bullet loses its first two items (both are the
  bug this fixes) and gains the §9.1/§9.2 residuals.
- Same file §"Inline markdown autoformat is ONE captured doc edit" (2707) — the
  capture fence is gone; the microtask is internal to `recordDocEdit`.
- Same file §"Projection + content-doc-aware split/merge" (2573) — split/merge
  record data; `undoTextOverride` and `joinOffset` are gone.
- `collab-session.ts` module comment — the `Y.UndoManager` paragraphs replaced by
  the run tracker and the staged-seed registry.
- `plugins/page/plugins/markdown-apply/CLAUDE.md` — the splice moved to the editor
  core barrel and is now shared with the browser.
- `plugins/primitives/plugins/undo-redo/` barrel description + CLAUDE — the
  pending-flush seam.
- `research/2026-07-07-page-per-block-crdt-plan-b.md` §Undo/redo — mark superseded,
  link here. Its "open question — verify cross-block merge-undo rebinding" is
  answered: the rebinding was the defect.
- `docs/plugins-details.md` / `plugins-compact.md` regenerate via
  `./equin build`.

---

## 14. Implementation sequence

Each step builds and passes checks on its own.

1. **Lift the splice.** Move `runs-splice.ts` + test into `editor/core`, export
   from the barrel, repoint `block-doc-text.ts`, de-mirror the corpus in the test.
   *No behaviour change.*
2. **Memoize the doc read.** Add `gen` + `runsNow()` to `BlockDocOwner`; switch
   `flushProjection` onto it. *No behaviour change; measurable cost drop.*
3. **Add the two hosts.** `web/internal/block-text-write.ts`:
   `TEXT_REPLAY_ORIGIN`, `spliceOpenBlockDoc`, `spliceStoredBlockDoc`,
   `applyBlockRuns`, `BlockTextReplayError`. Unused so far.
4. **Add the staged-seed registry.** `stageBlockDocSeed` + take-at-construction in
   `BlockDocOwner`; `preserveDoc` + `dispatchOverlay` funnel in the context. Undo
   of a delete now restores the doc bytes **even before entries change shape**,
   because the seed handoff is independent of the entry model. *This alone fixes
   the "re-seeded empty" half of yesterday's incident — ship it early.*
5. **Add the run tracker**, still alongside the `Y.UndoManager`, emitting
   `BlockRunsEdit` on a second channel; assert in tests that the two agree
   (the manager's item count vs the tracker's run count). Temporary belt.
6. **Add `registerPendingFlush`** to `undo-redo` and register
   `closeAllOpenTextRuns`; fix `UndoRedoThunkError`'s message.
7. **Switch the entries.** One `recordEntry`; `recordTextEdit` takes
   `BlockRunsEdit`; `recordDocEdit` defers internally; split and merge record
   data. Delete the `Y.UndoManager`, `captureEdit`, `captureBlockDocEdit`,
   `CapturedBlockDocEdit`, `undoTextOverride`, `appendRunsToBlockDoc`,
   `truncateBlockDocFrom`, and both callers' `queueMicrotask`.
8. **Conflict detection + report.** `applyBlockRuns`'s `expected` check, the
   tracker's mid-run abort, the sink, and the `reports/plugins/page-undo-conflict`
   sub-plugin.
9. **The lint rule** `no-adhoc-doc-write`.
10. **Tests and docs** per §12–13; flip the e2e phase-2 assertion last, as the
    acceptance gate.

---

## 15. Acceptance

- `crdt-undo-verify.ts` phase 2 asserts redo of typing into a recreated block
  **restores the text**, and the new phases 6–8 pass.
- No `isLive`-guarded replay, no `Y.UndoManager`, no `CapturedBlockDocEdit`
  anywhere under `plugins/page/`.
- `rg 'appendRunsToBlockDoc|truncateBlockDocFrom|undoTextOverride|captureBlockDocEdit'`
  returns nothing outside this document.
- A delete → undo of a block with bold text and an inline token restores the doc
  byte-for-byte (phase 7).
