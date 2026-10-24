# Page editor: unified single-stack undo/redo

## Context

In the Pages app, pressing **Enter** to create a new block and then **Ctrl/Cmd+Z** does *not* delete the created block. The block-split *is* correctly recorded on the structural undo stack — the bug is in **routing**.

The editor currently runs **two competing history stacks**:

1. **Lexical `HistoryPlugin`** — one instance *per block* (`block-text-${id}`), covering intra-block typing only.
2. **The `undo-redo` primitive** — one document-level stack for structural ops (split / merge / indent / outdent / move / delete).

`keyboard-plugin.tsx` routes Cmd+Z with a two-tier heuristic: *"if Lexical has text history (`lexCanUndo`), let Lexical handle it; else fall through to the structural `undo()`."* When Enter splits a block, focus jumps to the freshly-mounted block whose Lexical instance flips `CAN_UNDO` true on init/selection — so Cmd+Z is **eaten by an intra-block no-op** and never reaches the structural stack. The two stacks also can't interleave a global timeline (type A → split → type B can't undo in true chronological order).

**Root cause:** the source of truth is the `page_blocks` row tree, not a Lexical document. History must live at the block-tree level. Lexical owning a parallel per-block history is a layering error.

**Intended outcome:** one unified undo timeline covering **both** text and structure, one router, no `HistoryPlugin`. Text edits become `data.text` row patches recorded on the **same** stack and flowing through the **same** optimistic-patch pipeline as structural ops. Cmd+Z always reverses "the last thing I did," regardless of kind. This is the Notion model adapted to N per-block editors.

## Approach

### Decisions (confirmed with user)
- **Text undo = uniform row patches.** Text edits are recorded as `data.text` patches via the existing optimistic-patch pipeline (`dispatchPatch` → `{tag:"patch"}` → `POST /api/pages/:pageId/blocks/patch`), identical to structural undo. No EditorState snapshots.
- **Forward text saves unified onto optimistic patch.** Typing also persists through the optimistic-patch pipeline (not the current `PATCH /api/blocks/:id`), so forward edit and undo/redo are fully symmetric.
- Caret restoration is **approximate** (offset clamp via the existing helpers), not full selection. Acceptable v1.

### Changes

**1. `plugins/page/plugins/editor/web/block-editor-context.tsx` — centralize text persistence + history**
- Factor the record body out of `recordStructural` (lines 258–279) into a shared helper `recordPatchEntry(before, after, label, focusId, coalesceKey?)` that adds an optional `coalesceKey` to the `record({...})` call (`HistoryEntry.coalesceKey` already exists). `recordStructural` keeps calling it with no key (structural ops never coalesce).
- Add a context method `commitText(blockId, nextRuns, caretOffset)`:
  ```ts
  const before = rowsRef.current;
  const after = before.map((b) =>
    b.id === blockId ? { ...b, data: { ...(b.data ?? {}), text: nextRuns } } : b,
  );
  const { undo, redo } = patchesFromDiff(diffBlocks(before, after));
  if (isEmptyPatch(undo) && isEmptyPatch(redo)) return;
  record({
    label: "Edit text",
    coalesceKey: blockId,            // typing run -> one undo step
    undo: () => { dispatchPatch(undo); queueMicrotask(() => focusBlock(blockId, caretOffset)); },
    redo: () => { dispatchPatch(redo); queueMicrotask(() => focusBlock(blockId, caretOffset)); },
  });
  dispatchPatch(redo);               // forward apply (optimistic patch)
  ```
  This **reuses** `diffBlocks`, `patchesFromDiff`, `isEmptyPatch`, `dispatchPatch` (lines 246–252), and `record` — the same machinery structural ops already use. Forward typing now flows through `dispatchPatch`/optimistic instead of `updateBlockMutation`.
- Expose `commitText` on the context value; extend `focusBlock` to accept an optional caret offset (reuse `$placeCaretAtOffset` from `block-text-extensions.ts`).
- Leave `BlockEditorAPI.update` (`PATCH /api/blocks/:id`, lines 400–403) for **non-text** data (e.g. to-do `checked`, callout color) — out of scope; note as a follow-up to fully unify.

**2. `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — drop Lexical history, route saves to `commitText`**
- **Remove `<HistoryPlugin />`** (line 210) and its import.
- Change `field.onSave` (lines 119–122) from `editor.update({ ...data, text: next })` to `commitText(block.id, next, caretOffset)`. Capture `caretOffset` via `$caretOffsetWithinParagraph()` (already used by `ValueSyncPlugin`) inside a read at save time.
- `ValueSyncPlugin` is unchanged: when an undo/redo patch updates the resource's `data.text`, `field.value` changes and `ValueSyncPlugin` re-syncs the editor via `runsToLexical` (its `selfWriteRef` already suppresses the resulting echo-save). The `undo-redo` `replaying` guard already blocks re-recording during a thunk.

**3. `plugins/page/plugins/editor/web/components/keyboard-plugin.tsx` — collapse the two-tier router**
- Delete the `CAN_UNDO_COMMAND` / `CAN_REDO_COMMAND` observers and the `lexCanUndo`/`lexCanRedo` vars (lines 199–218).
- In the `KEY_MODIFIER_COMMAND` handler (lines 219–241): Cmd+Z → `structuralRef.current.undo()`, Cmd+Shift+Z / Cmd+Y → `structuralRef.current.redo()`, unconditionally (keep `preventDefault`). With `HistoryPlugin` gone, Lexical registers no `UNDO_COMMAND`, so there is no text tier to delegate to.
- Remove now-unused imports (`UNDO_COMMAND`, `REDO_COMMAND`, `CAN_UNDO_COMMAND`, `CAN_REDO_COMMAND`).
- `structuralRef` wiring (lines 52–53) stays.

**4. `plugins/page/plugins/editor/web/components/block-editor.tsx` — no logic change**
- Block-selection-mode `onKeyDown` (lines 388–407) already calls `undo()`/`redo()` directly — correct under the unified model.
- `UndoRedoProvider` mount (lines 126–132) stays.

**5. Docs**
- Rewrite the "Undo / redo (two-tier)" section of `plugins/page/plugins/editor/CLAUDE.md` to describe the **single unified stack**: text edits recorded as `data.text` patches with `coalesceKey: block.id`, `HistoryPlugin` removed, keyboard routes all undo/redo to the structural stack. Update the "not recorded" list (text is now recorded; `bulkMove`/`bulkDuplicate`/`paste` still pending).

### Why this is the clean long-term shape
One stack, one patch pipeline (`optimistic` `{tag:"patch"}`), one router. Text and structure interleave in true chronological order. No `lexCanUndo` guessing. The block row stays the single source of truth; the live Lexical editor is a pure view that re-syncs from the resource. `coalesceKey` + the editable-field debounce give Notion-like "undo a chunk of typing" granularity for free.

### Notes / risks
- **Caret fidelity:** offset-clamp restoration only (matches the existing `ValueSyncPlugin` heuristic), not anchor/focus selection. Acceptable v1; full selection would require the EditorState path we deliberately rejected.
- **Coalescing:** continuous typing emits trailing-debounced saves; same-`block.id` entries within the 500 ms window merge (keep first `undo`, adopt latest `redo`). Bump `coalesceWindowMs` if bursts split into too many steps.
- **IME/composition:** runs are captured post-composition at save time, so dropping `HistoryPlugin` does not regress IME.
- **Non-text `data` edits** (checkbox, color) remain un-recorded via `BlockEditorAPI.update` — explicit follow-up to fully unify.
- **`useUndoRedoShortcuts`:** not adopted (the per-block `keyboard-plugin` handler is kept, minimal change). Possible future simplification: one surface-level `useUndoRedoShortcuts` once two-tier is gone.

## Critical files
- `plugins/page/plugins/editor/web/block-editor-context.tsx` — `recordStructural` (258–279), `dispatchPatch` (246–252), `optimistic` (179–194), `makeBlockAPI.update` (400–403); add `commitText` + `recordPatchEntry`.
- `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — remove `<HistoryPlugin/>` (210); reroute `field.onSave` (119–122).
- `plugins/page/plugins/editor/web/components/keyboard-plugin.tsx` — collapse `KEY_MODIFIER_COMMAND` (219–241), drop CAN_UNDO/REDO observers (199–218).
- `plugins/page/plugins/editor/web/components/value-sync-plugin.tsx` — `$caretOffsetWithinParagraph` / `$placeCaretAtOffset` reference (no change expected).
- `plugins/page/plugins/editor/web/internal/block-text-extensions.ts` — `serializeBlockRuns` (264–275), caret helpers.
- `plugins/primitives/plugins/undo-redo/web/internal/{stack,use-undo-redo}.ts` — `HistoryEntry.coalesceKey`, `record`, `replaying` guard (read-only; reused).
- `plugins/page/plugins/editor/CLAUDE.md` — rewrite undo section.

## Verification
1. `./equin build`, open `http://<worktree>.localhost:9000/pages`, open a page.
2. **The reported bug:** type text → Enter (split) → Cmd+Z → the new block is removed. Script with `e2e/screenshot.mjs` (`--click`/keyboard) for before/after.
3. **Text undo:** type a sentence → Cmd+Z → reverts as a chunk; Cmd+Shift+Z → reapplies.
4. **Interleaving:** type in A → Enter → type in B → Cmd+Z ×3 → undoes B-text, then the split, then A-text, in order.
5. **Persistence:** after an undo, reload the page → the undone state persisted (patch hit the server).
6. **Block-selection mode:** select a block (no editor focused) → Cmd+Z/Cmd+Shift+Z drive the same stack.
7. `./equin check` (type-check + boundaries). If a pure helper is extracted, add a co-located `*.test.ts` and run `bun test plugins/page/plugins/editor/...`.
