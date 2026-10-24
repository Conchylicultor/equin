# Block text fields must participate in the document undo stack

## Context

Pasting inside a `/code` block cannot be undone. The reported symptom is one instance of
a class: a page block that renders its own plain-text editing surface silently opts out of
the editor's undo model, and nothing catches it.

**The chain, for `code-block`:**

1. The textarea (`plugins/page/plugins/code-block/web/components/code-block.tsx:264`) declares
   no undo owner. `resolveUndoOwner` walks `closest("[data-undo-owner]")`
   (`plugins/primitives/plugins/undo-redo/web/internal/undo-owner.ts:77`) and finds the page
   body's `surfaceUndoProps` (`plugins/page/plugins/editor/web/components/block-editor.tsx:1626`),
   so `mod+z` resolves to `surface`. The shortcut manager then calls `preventDefault()`
   (`plugins/primitives/plugins/shortcuts/web/internal/shortcut-manager.tsx:71`), killing the
   browser's own textarea history — the one that handles paste correctly.
2. Nothing takes its place for up to 500 ms. The only thing that records is `editor.update()`,
   called from `useEditableField`'s debounced `onSave`. Cmd+Z inside that window reverses an
   unrelated earlier document edit while the pasted text sits untouched.
3. Even after the debounce, undo is invisible: `useEditableField`'s mirror effect drops external
   writes while the field has focus (`plugins/primitives/plugins/editable-field/web/use-editable-field.ts:76`),
   so the reverted value never reaches the textarea — and the next blur flushes the stale draft
   back over it.

**The class.** An audit of every block renderer found the same pattern reproduced in
`math/equation` (`equation-block.tsx:37,127`) — byte for byte, undetected. Three more surfaces
have the routing half only (`bookmark-block.tsx:93`, `embed-block.tsx:65`, `place-search.tsx:101`);
they lose nothing, but Cmd+Z while typing in them reverses an unrelated document edit. Everything
else is clean: text blocks keep their content in Lexical/Yjs, media blocks write once
synchronously on upload.

**Why nothing caught it.** `structural-undo.test.tsx` enforces *every editor mutation lands
exactly one undo entry*. It cannot see a block that never calls a mutation while you type. The
invariant that was missing — *every editing surface belongs to some undo history* — was held only
by a doc comment (`undo-owner.ts:34`), and that comment is **wrong** inside the page body: it
promises undeclared textareas resolve to `local`, which is true only when no ancestor declares.
Two authors read it and shipped the same bug.

**Root cause, one level down.** `editor.update()` funnels through `commitRow`
(`block-editor-context.tsx:1010`), which records the undo entry *and* dispatches the network
patch in the same synchronous call. A block editing at input frequency must therefore choose
between spamming the network and deferring its undo entry. Both victims chose the same wrong
half. The fix has to separate those two things and then make the separated form the only
reachable one.

**Intended outcome.** Cmd+Z inside a code or equation block reverses your last typing burst or
paste in that block, then keeps walking back through the document's history in true chronological
order — the same behavior every Lexical text block already has. And a sixth instance of this bug
becomes unwritable.

## Decision taken (overturn this first if you disagree)

**One document stack, text-grained** — not native field undo.

The block keeps a text-grained history that is recorded synchronously onto the shared per-tab
stack, exactly as `recordTextEdit` (`block-editor-context.tsx:888`) already mirrors each
`Y.UndoManager` item for Lexical blocks. Rejected alternative: spreading `localUndoProps` on the
textareas to hand Cmd+Z back to the browser. That is a two-line fix, but it leaves two histories
on screen that never interleave (undo inside the field cannot reach the document; after blur, one
Cmd+Z swallows the entire code edit), and it fixes neither the unrecorded window nor the
focused-field clobber. The editor's stated design is one chronological stack; a native-undo island
would be the only text surface in the page that opts out of it.

`localUndoProps` is still the right answer for the *transient* fields (§3) — those are chrome, not
document content.

## Plan

### 1. `useBlockPlainText` + `<BlockTextArea>` — the sanctioned editing surface

New files under `plugins/page/plugins/editor/web/`, exported from its web barrel alongside
`useVoidCaret` / `useCaretEscape` / `BLOCK_INSET` — the established home for generic
block-renderer plumbing (`components/void-caret.tsx` is the shape to mirror).

The hook owns everything both victims currently hand-roll or get wrong:

- **Draft state**, rendered at input frequency. Not `useEditableField` — block fields stop using
  it entirely (see §4).
- **Synchronous undo recording.** `record()` from `useScopedUndoRedo()`
  (`primitives/undo-redo/web`) on every change, with `coalesceKey: blockId`. `recordEntry`
  (`stack.ts:69`) keeps the top entry's `undo` pinned to the start of the run and adopts each new
  `redo`, so recording per keystroke does *not* grow the stack — a typing run collapses to one
  step and a pause past `coalesceWindowMs` starts the next. Scoped, because the thunks close over
  per-mount state.
- **Undo/redo thunks** set the local draft *and* commit the row through `editor.update`. The
  primitive's re-entrancy guard (`use-undo-redo.ts:64`) makes the nested `record()` inside
  `commitRow` a silent no-op during replay, so this does not double-record.
- **Selection restore.** Capture `selectionStart/End` at record time; restore on undo/redo.
  `commitRow`'s `caretOffset` → `focusBlock` path only focuses a void block, it does not restore a
  textarea selection — the primitive must.
- **Debounced persist only.** `editor.update()` on a timer, decoupled from recording. This is the
  half that was conflated.
- **Void-caret registration** — `useVoidCaret({blockId, isFocused, editor, focus})` plus the
  returned `onFocus`, so a caller can no longer forget it and be skipped by `navigate()`.
- **Boundary keys** — Backspace-at-empty → `editor.remove()`, ArrowUp at offset 0 →
  `navigate("up")`, ArrowDown at end → `navigate("down")`. Currently duplicated verbatim in both
  blocks.
- **Sync status** — `useReportSync` with `savedAt` stamped inside the persist success handler,
  never inferred from a derived `isSaving` edge (`primitives/sync-status/CLAUDE.md` is emphatic;
  the inference version was a known bug). Callers pass a human `label`.

`<BlockTextArea>` wraps the hook with the baseline textarea and its styling contract
(`spellCheck={false}`, `autoCorrect/autoCapitalize="off"`, `caret-foreground outline-none
placeholder:text-muted-foreground`), forwarding a ref and accepting an `onKeyDown` that runs
*before* the boundary handling so a caller can add its own keys.

**Deliberately out of scope for the primitive** (block-specific, stays in each block): the shiki
underlay + shared `METRICS` caret-alignment contract, the language `Select`, Tab→two-spaces and
the copy button (code-block); the KaTeX preview, Enter-commits, and the display/edit toggle
(equation).

### 2. Migrate the two full instances

- `code-block.tsx` — drop `useEditableField` and the hand-rolled `useVoidCaret` + `onKeyDown`
  boundary block; render `<BlockTextArea>` as the transparent overlay layer, keeping `METRICS`,
  `layerClasses()` and the underlay exactly as they are. Tab handling stays local.
- `equation-block.tsx` — same, simpler: no underlay. Enter-commits stays local.

Both keep `caret: "renderer"`.

### 3. Transient fields declare themselves

Spread `localUndoProps` on `bookmark-block.tsx:93`, `embed-block.tsx:65`, `place-search.tsx:101`.
These hold no persisted draft; the browser's own history is the correct owner.

Do the same for the portaled popover fields — `formatting/link`'s URL input, the `page-link`
picker query, and `math/inline`'s expression textarea (`inline-math-node.tsx`). They are correct
**today only by accident**: `InlinePopover` portals to `document.body`, which severs them from the
`surfaceUndoProps` subtree so `closest()` finds nothing and falls back to `local`. That accident is
one plausible commit from ending — `PortalForwardProvider`
(`primitives/css/ui-kit/web/components/portal-forward.tsx`) exists precisely to re-stamp
ancestry-derived `data-*` signals across portals, already carries four of them (theme scope,
ui-context lineage ×2, `data-pane-id` ×2), and its own doc invites new ones as "a single provider
and zero portal-surface edits". Forwarding `data-undo-owner` would flip all three controls to
`surface` with no test to catch it. Declaring them explicitly defuses that permanently.

Also fix the false promise at `undo-owner.ts:34` and state the nesting rule it got wrong.

### 4. `useEditableField`'s focused-field clobber — separate, staged

After §2 no page block uses the hook, but **all 13 remaining call sites have the same defect**, and
every one of them is fed by a live-state resource: task title and description, agent name and
prompt, conversation note, page and story titles, workflow definitions, song title, deploy server
fields. An agent renaming a task, or another tab, is silently discarded while the field has focus —
and then overwritten on blur.

`frozen: true` does not solve this and is dead code (declared, implemented, used nowhere). Replace
the unconditional `if (focusedRef.current) return` with a reconcile: adopt the external value when
the draft has no local divergence (draft equals last-saved); when it does diverge, keep the user's
draft but surface the conflict through the existing sync-status seam rather than dropping the write
silently. Land this as its own commit with its own verification — it is the largest blast radius in
this plan and is not needed to fix the reported bug.

### 5. Lint rule — make the sixth instance unwritable

New `plugins/page/plugins/editor/lint/no-unhistoried-block-field.ts`, registered in that plugin's
`lint/index.ts`. Precedent to copy byte-for-byte: `no-adhoc-block-id.ts` in the same directory —
contributed rules are enabled repo-wide at `error` (`build-lint-config.ts:286`), so it scopes
itself by checking `context.filename` against `plugins/page/`, exactly as that rule does for
`plugins/page/plugins/editor/`.

The rule reports a raw `<textarea>`, `<input>` of a text-ish type, or `contentEditable` JSX under
`plugins/page/**/web` unless it spreads `localUndoProps`. The sanctioned way to hold persisted text
is `<BlockTextArea>`; the sanctioned way to hold transient text is the marker. The message names
both. Exempt the primitive's own implementation file via the barrel's `ignores` allowlist, the way
`data-view/lint/index.ts` exempts its own dirs.

Note the jiti constraint: rule files cannot import `@plugins/*`, so the rule inlines the attribute
name rather than importing `UNDO_OWNER_ATTR`. If that duplication matters, add a small
`*-in-sync` check; a literal plus a comment is acceptable for one string.

## Files

| Path | Change |
| --- | --- |
| `plugins/page/plugins/editor/web/components/block-text-area.tsx` | new — hook + component |
| `plugins/page/plugins/editor/web/index.ts` | export both |
| `plugins/page/plugins/code-block/web/components/code-block.tsx` | migrate |
| `plugins/page/plugins/math/plugins/equation/web/components/equation-block.tsx` | migrate |
| `bookmark-block.tsx`, `embed-block.tsx`, `place-search.tsx`, `inline-math-node.tsx`, `formatting/link`, `page-link` picker | `localUndoProps` |
| `plugins/primitives/plugins/undo-redo/web/internal/undo-owner.ts` | correct the doc comment |
| `plugins/primitives/plugins/editable-field/web/use-editable-field.ts` | §4, separate commit |
| `plugins/page/plugins/editor/lint/no-unhistoried-block-field.ts` + `lint/index.ts` | new rule |
| `plugins/page/plugins/editor/CLAUDE.md` | document the primitive as the one way |

## Verification

1. **`./equin check`** — the new lint rule must fail on a deliberately reintroduced raw
   `<textarea>` in a block, and pass on the migrated tree. `type-check` covers the rest.
2. **jsdom test**, `plugins/page/plugins/editor/web/__tests__/block-text-undo.test.tsx`, reusing
   `structural-undo.test.tsx`'s harness — `PluginProvider` + `UndoRedoProvider` +
   `BlockEditorProvider` + the `RowsProbe` stand-in (load-bearing: without it `rowsRef` is empty
   and the suite passes vacuously) and its `expectRecorded` quadruple: forward changed the rows,
   `canUndo` flipped, undo restores exactly, redo reproduces. Cases: one typing run is one entry;
   a paste is one entry; a pause past the coalesce window starts a second; undo restores the
   textarea's visible value *and* selection while focused; a burst records before any network write
   fires.
3. **`./equin build`** (background, end the turn), then an e2e script at
   `plugins/page/plugins/code-block/e2e/undo-verify.ts` driving the deployed app with the shared
   harness: create a code block, type, paste a multi-line snippet, press Cmd+Z immediately (inside
   the old 500 ms window — this is the reported bug and must now revert the paste), press again to
   reach the typing, then again to reach the block insert. Repeat the core of it for equation.
4. **Manual**, since it is the half a test cannot see: with a page open beside an agent
   conversation, confirm Cmd+Z in the agent prompt still undoes only the prompt, and Cmd+Z in a
   link popover still undoes only the URL field.
