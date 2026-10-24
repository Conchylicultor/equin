# Page editor: unify non-text block edits onto the single undo/redo stack

## Context

The page editor was recently unified onto **one** document-level undo/redo stack
(`@plugins/primitives/plugins/undo-redo`): structural ops (split/merge/indent/…)
**and** text edits now record `BlockPatch` thunks and flow through the same
optimistic-patch pipeline (`dispatchPatch` → `POST /api/pages/:pageId/blocks/patch`).
See `research/2026-06-18-page-unified-undo-redo.md` and the editor `CLAUDE.md`.

**The gap that remains:** every *block-type-specific, non-text* `data` mutation
still bypasses that stack. To-do checkbox toggles, callout icon/color changes,
image upload/resize/remove, code/equation/embed/bookmark/file/audio/video/page-link
edits — all call `BlockEditorAPI.update(data)`, which fires
`PATCH /api/blocks/:id` (`updateBlock`) directly. That path is **not optimistic**
and is **not recorded**, so `Cmd+Z` does nothing for them. This breaks the core
expectation that undo reverses "the last thing I did," regardless of block type,
and a new block type silently inherits the same gap.

**Intended outcome:** every block mutation — across all current and future block
types — is uniformly recorded on and reversible via the one stack. Enforced at the
`BlockEditorAPI` boundary: there is exactly **one** internal write chokepoint, so a
block renderer's only data-write affordance (`editor.update`) is always recorded.

### Why not delete the bypass endpoint

`updateBlock` (`PATCH /api/blocks/:id`) **must stay** — it is also used *outside*
any editor undo surface, where there is no `UndoRedoProvider` to record into:
`apps/story/shell/story-header.tsx`, `apps/pages/page-tree/page-header.tsx`,
`pages-sidebar.tsx`, and `page-cover.tsx` (page title / sidebar expand / cover).
So enforcement lives at the in-editor API boundary, not by removing the endpoint.
(Decision: **chokepoint only** — no lint rule. A renderer importing the raw
endpoint would be an egregious, non-idiomatic bypass; the realistic path is closed.)

## Approach

All non-text edits already converge on a single method — `BlockEditorAPI.update(data)`
(callers spread existing data and pass the **full** new `data` object, e.g.
`editor.update({ ...data, checked: !checked })`). Reroute that one method through the
**same** record + optimistic-patch machinery `commitText` already uses. Correctness
is inherited: a data-only patch is structurally identical to a text-only patch
(`isPatchReflected` keys on `parentId/type/rank/expanded`, **not** `data`), and the
text path is shipped + verified.

### 1. `block-editor-context.tsx` — one `commitRow` chokepoint

Introduce a single internal helper that all single-row mutations funnel through,
generalizing the existing `commitText` (lines 325–348):

```ts
// Single chokepoint for any single-row mutation: snapshot rows, apply `transform`
// to the target row, diff into a minimal patch pair, optionally record it on the
// unified stack, then dispatch the forward patch through the SAME optimistic pipeline.
const commitRow = useCallback(
  (
    blockId: string,
    transform: (b: Block) => Block,
    opts: { label: string; coalesceKey?: string; caretOffset?: number; record?: boolean },
  ) => {
    const before = rowsRef.current;
    const after = before.map((b) => (b.id === blockId ? transform(b) : b));
    const { undo: undoPatch, redo: redoPatch } = patchesFromDiff(diffBlocks(before, after));
    if (isEmptyPatch(undoPatch) && isEmptyPatch(redoPatch)) return;
    if (opts.record !== false) {
      record({
        label: opts.label,
        coalesceKey: opts.coalesceKey,
        undo: () => { dispatchPatch(undoPatch); queueMicrotask(() => focusBlock(blockId, opts.caretOffset)); },
        redo: () => { dispatchPatch(redoPatch); queueMicrotask(() => focusBlock(blockId, opts.caretOffset)); },
      });
    }
    dispatchPatch(redoPatch); // forward apply (optimistic overlay + POST /blocks/patch)
  },
  [record, dispatchPatch, focusBlock],
);
```

Then re-express the existing/changed methods as thin callers (one funnel):

- **`commitText(blockId, nextRuns, caretOffset)`** → `commitRow(blockId, (b) => ({ ...b, data: { ...(b.data ?? {}), text: nextRuns } }), { label: "Edit text", coalesceKey: blockId, caretOffset })`. (Behavior identical to today.)
- **`update(data)`** (lines 471–473) → `commitRow(blockId, (b) => ({ ...b, data }), { label: "Edit block", coalesceKey: blockId })`. Now optimistic **and** recorded. `coalesceKey: blockId` collapses streaming editors (e.g. `code-block`'s debounced `editor.update({ code })`) and rapid same-block edits into one undo step — matching the text model.
- **`convertTo(type, data, opts?)`** (lines 481–496) → `commitRow(blockId, (b) => ({ ...b, type, data, expanded: opts?.expanded ?? b.expanded }), { label: "Change block type" })` (no `coalesceKey`). Replaces the current `recordStructural(...)` + `updateBlockMutation(...)` pair, making convert's forward apply flow through the optimistic patch pipeline like its undo/redo (symmetry — the same reason text saves were unified). Already undoable today; this just removes the asymmetric `PATCH` forward write.
- **`setExpanded(expanded)`** (lines 474–480) → `commitRow(blockId, (b) => ({ ...b, expanded }), { label: "Toggle collapse", record: false })`. Stays **out of history** (view state; Notion doesn't undo collapse/expand) but moves onto the optimistic pipeline for snappiness and to drop the editor's last in-context use of `updateBlock`.

Cleanup: remove `updateBlockMutation` (line 237) and the `updateBlock` import (line 17) from this file — no longer used in-editor. Drop `updateBlockMutation` from the `makeBlockAPI` deps array (line 599). Keep `recordStructural`/`recordPatchEntry` (still used by `dispatchOp`, `move`, `bulkDelete`).

### 2. No changes to block-type plugins

Every renderer keeps calling `editor.update(...)` exactly as today — they are
recorded automatically. No per-type edits. This **is** the structural guarantee:
a new block type's only data-write affordance is the now-recorded `update`.

### 3. Server — no change

`POST /api/pages/:pageId/blocks/patch` (`handle-patch-blocks.ts`) already does a
blind full-row upsert and fires `notifyStructuralChange` + `blocksChanged`
after-callbacks. Data edits routed through it therefore still trigger the
`blocksChanged`-bound reconcilers (attachment links for image/file/audio/video,
search reindex, backlinks) — equivalent to the old `notifyBlockChange`. `updateBlock`
+ `handle-update-block.ts` stay (used by the page-level consumers in §Context).

### 4. Docs

Update the "Undo / redo (one unified stack)" section of
`plugins/page/plugins/editor/CLAUDE.md`:
- Move non-text `data` edits from the **"NOT recorded"** list to the recorded set:
  all `BlockEditorAPI.update` edits now record via the shared `commitRow` chokepoint
  (`coalesceKey: blockId`), and `convertTo`'s forward apply now uses the patch
  pipeline. `setExpanded` remains the documented exception (view state, `record:false`).
- Note `bulkMove`/`bulkDuplicate`/`paste` are still the only pending follow-ups
  (they mint server ids/ranks; a clean inverse needs those endpoints to return rows).

## Critical files

- `plugins/page/plugins/editor/web/block-editor-context.tsx` — add `commitRow`;
  re-express `commitText` (325–348), `update` (471–473), `setExpanded` (474–480),
  `convertTo` (481–496) through it; drop `updateBlockMutation` (237, 599) + import (17).
  Reuses `dispatchPatch` (263–269), `diffBlocks`/`patchesFromDiff`/`isEmptyPatch`
  (`core/block-diff.ts`), `record`/`focusBlock`.
- `plugins/page/plugins/editor/web/types.ts` — `BlockEditorAPI.update` signature is
  unchanged (`update(data: unknown): void`); no edit expected.
- `plugins/page/plugins/editor/CLAUDE.md` — undo/redo section rewrite.
- (Unchanged, referenced) `web/internal/optimistic-block-ops.ts`
  (`isPatchReflected`/`applyPatch`/`buildPatchOverlayOp`),
  `server/internal/handle-patch-blocks.ts`, `core/endpoints.ts` (`patchBlocks`).

## Notes / risks

- **Coalescing rapid distinct edits:** two intentional edits to the same block
  within the 500 ms window merge into one undo step (e.g. checkbox toggle then
  immediate color change). Acceptable v1 — identical to the existing text model;
  bump `coalesceWindowMs` only if it bites.
- **Confirmation drop timing:** `isPatchReflected` ignores `data`, so a data-only
  patch confirms on structure alone. Text already relies on this without flicker;
  verify the same for a checkbox toggle (no revert-then-reapply). If a flicker
  appears, the fix is to add a `data` deep-equal to `isPatchReflected` — which would
  improve *all* data patches (text included), not a one-off patch.
- **Focus on undo of a non-text edit:** `focusBlock(blockId)` is best-effort; void
  blocks with no focus handle fall through to `pendingFocusRef` harmlessly.
- **No server / schema / migration changes**, so `migrations-in-sync` is unaffected.

## Verification

1. `./equin build`; open `http://<worktree>.localhost:9000/pages`, open a page.
2. **Reported bug class — checkbox:** add a to-do, toggle it checked → `Cmd+Z` →
   unchecks; `Cmd+Shift+Z` → re-checks. Script via `e2e/screenshot.mjs`
   (`--click` + keyboard) for before/after.
3. **Callout color / icon:** change a callout's color → `Cmd+Z` reverts it.
4. **Image:** upload into an empty block → `Cmd+Z` clears it back to the empty
   state; resize → `Cmd+Z` restores prior width.
5. **Interleave with text/structure:** type in block A → toggle a checkbox in B →
   Enter-split in A → `Cmd+Z` ×3 undoes split, then checkbox, then text, in order.
6. **convertTo still works + undoes:** `/` turn a block into a heading → renders →
   `Cmd+Z` reverts the type.
7. **Persistence:** after an undo, reload the page → undone state persisted
   (the patch hit the server).
8. **setExpanded unchanged:** collapsing a toggle is optimistic and **not** on the
   undo stack (Cmd+Z does not re-expand it).
9. **Page-level paths intact:** edit a page title (page header) and toggle sidebar
   tree expand — still work (they keep using `updateBlock`).
10. `./equin check` (type-check + boundaries).
