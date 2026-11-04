import {
  $addUpdateTag,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  SKIP_DOM_SELECTION_TAG,
  type LexicalEditor,
} from "lexical";
import { $appendRuns, type RichText } from "../../core";
import type { CaretLandOptions } from "../caret-surface";
import {
  $paragraphsPlainLength,
  $placeCaretAtLinearOffset,
  blockTextTokenExtensions,
} from "./block-text-extensions";
import { focusEditor, SKIP_SCROLL_TAG } from "./editor-focus";

// Text surgery on a block's BOUND Lexical editor (per-block CRDT plan).
// Split/merge are structural ops that also move TEXT between two content
// docs; the row-level `data.text` rewrite the reducer performs is ignored by
// the bound editor, so the live content must be
// edited too. Driving the change THROUGH LEXICAL (instead of hand-rolling
// `Y.XmlText` deltas) is the idiomatic `@lexical/yjs` path: the
// `CollaborationPlugin` binding syncs the edit into the block's `Y.Doc`
// exactly like typing, so marks and decorator tokens are preserved for free
// and the change fans out through the normal doc-update flush.

/**
 * Inside a Lexical update: delete the content from linear `offset` (the
 * stored-runs plain-text basis — the same basis as the split `position` and
 * `splitRuns`) to the very end. Pure node-graph + model-selection ops, so it
 * runs identically in a live editor and a headless replica (`editYDocState`).
 *
 * The cut is a POSITION, not a CRDT-relative anchor: a concurrent append past
 * `offset` would be swept along with the tail — fine for the live split, whose
 * caller reads the offset off the same editor it cuts. A block with no mounted
 * editor is never cut this way any more: its content is brought to a run list
 * by the stored-doc splice (`block-text-write-stored.ts`), whose alignment
 * removes exactly what changed.
 */
export function $truncateFromLinearOffset(offset: number): void {
  if (offset >= $paragraphsPlainLength()) return; // caret at end — nothing to cut
  $placeCaretAtLinearOffset(offset);
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return;
  // Extend the collapsed caret's focus to the last leaf's end, then delete.
  const last = $getRoot().getLastDescendant();
  if (last === null) return;
  if ($isTextNode(last)) {
    sel.focus.set(last.getKey(), last.getTextContentSize(), "text");
  } else if ($isElementNode(last)) {
    // Empty paragraph as the last node — focus at its (empty) child list end.
    sel.focus.set(last.getKey(), last.getChildrenSize(), "element");
  } else {
    // Atomic leaf (decorator / line break): element position AFTER it.
    const parent = last.getParentOrThrow();
    sel.focus.set(parent.getKey(), last.getIndexWithinParent() + 1, "element");
  }
  if (!sel.isCollapsed()) sel.removeText();
}

/**
 * Delete the block's content from linear `offset` to the very end. The
 * Enter-split truncation: after it, the bound editor (and via the binding, the
 * content doc) holds exactly the HEAD the reducer computed for the row.
 *
 * `discrete: true` is load-bearing: the split runs this inside the owner's
 * `untracked` scope (the run tracker ignores the transaction, and the split's
 * own entry carries the edit as data), which closes when the wrapper returns —
 * the binding's Yjs transaction must therefore land synchronously (Lexical's
 * default commit is a microtask, which would leak the edit past the scope and
 * double-record it as a plain typing entry).
 *
 * `SKIP_DOM_SELECTION_TAG` is load-bearing too (Stage 4a): this is BACKGROUND
 * surgery on the block the user is LEAVING — the split already moved DOM focus
 * to the new block. Without the tag, reconciling this update's internal
 * selection (the cut point `removeText` leaves) writes it to the DOM, pulling
 * focus back into the origin and stranding the caret there (the new block's
 * caret placement then bails on its activeElement guard).
 */
export function truncateBlockTextFrom(
  editor: LexicalEditor,
  offset: number,
): void {
  editor.update(
    () => {
      $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      $truncateFromLinearOffset(offset);
    },
    { discrete: true },
  );
}

/**
 * Inside a Lexical update: delete the content in the linear range `[from, to)`
 * — the same stored-runs plain-text basis as {@link $truncateFromLinearOffset},
 * the split `position` and `splitRuns`. The sibling verb for a strip that is NOT
 * a tail cut: a `/query` span in the middle of a line, a `> ` markdown prefix at
 * its start.
 *
 * `to` is resolved to a selection point BEFORE `from` moves the caret, because
 * placing the caret does not mutate the node graph — so both points stay valid.
 * `removeText` then collapses the selection at `from`, which is exactly where
 * the caret belongs after a strip (the user stays in this block).
 *
 * Like its sibling the cut is POSITIONAL, not a CRDT-relative anchor.
 */
export function $deleteLinearRange(from: number, to: number): void {
  const total = $paragraphsPlainLength();
  const start = Math.min(Math.max(from, 0), total);
  const end = Math.min(Math.max(to, 0), total);
  if (end <= start) return; // empty span — nothing to strip
  $placeCaretAtLinearOffset(end);
  const endSel = $getSelection();
  if (!$isRangeSelection(endSel)) return;
  const focusKey = endSel.anchor.key;
  const focusOffset = endSel.anchor.offset;
  const focusType = endSel.anchor.type;
  $placeCaretAtLinearOffset(start);
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return;
  sel.focus.set(focusKey, focusOffset, focusType);
  if (!sel.isCollapsed()) sel.removeText();
}

/**
 * Delete the block's content in the linear range `[from, to)`. THE way a block
 * strips text it never meant to keep — the `/query` a slash-menu commit consumed,
 * the markdown prefix a shortcut consumed. Text is doc-owned, so the strip must
 * happen HERE (through Lexical → the collab binding → the block's `Y.Doc`); a
 * type change writing the stripped text into `page_blocks.data.text` cannot
 * strip anything, because that row field is a projection of this doc.
 *
 * `discrete: true` is load-bearing, for a reason its siblings don't have: the
 * slash-menu commit runs INSIDE the caret menu's own `editor.update()`, so this
 * update is nested and Lexical defers it to the end of the outer one. Without
 * `discrete` the outer commit — and hence the binding's Yjs transaction — is a
 * microtask, racing the React re-render the accompanying type write schedules.
 * Lose that race against a type change that swaps the block's renderer
 * (quote/callout own their own component today) and the edit dies with the
 * unmounted editor: the literal `/callout` survives in the doc forever.
 * `discrete` makes the nested flush synchronous, so it always wins.
 *
 * Deliberately NOT tagged `SKIP_DOM_SELECTION_TAG` (unlike
 * {@link truncateBlockTextFrom}): this is FOREGROUND surgery on the block the
 * user is standing in, and the collapsed selection `removeText` leaves at `from`
 * IS where the caret must end up.
 */
export function deleteBlockTextRange(
  editor: LexicalEditor,
  from: number,
  to: number,
): void {
  editor.update(() => $deleteLinearRange(from, to), { discrete: true });
}

/**
 * `focus()`'s ONE landing policy, in both scroll modes:
 *
 * > **An existing selection wins; only a selection-less editor lands at the
 * > content START.**
 *
 * The first half is what makes `focus()` safe to call on the block that ALREADY
 * holds the caret — which every structural op that keeps the user in place does
 * (Tab-indent / Shift+Tab-outdent re-focus their own block after the move). The
 * second half is the freshly-split/inserted case: a brand-new editor has no
 * prior selection, and Lexical's default is rootEnd — wrong for a split, whose
 * caret belongs BEFORE the tail.
 *
 * `scroll: true` is literally Lexical's `editor.focus()`, which already encodes
 * exactly this (`selection.dirty = true` when one exists, else the
 * `defaultSelection`). The no-scroll arm has to hand-roll it — `editor.focus()`
 * offers no `preventScroll` — so it must reproduce BOTH halves: marking the live
 * selection dirty is what forces the reconciler to write it back to the DOM,
 * the same restore `editor.focus()` performs. Dropping that half (an
 * unconditional `$getRoot().selectStart()`) is what silently sent the caret home
 * on every Tab.
 */
function focusRestoringSelection(editor: LexicalEditor, scroll: boolean): void {
  focusEditor(editor, scroll, "rootStart");
  if (scroll) return;
  // No-scroll: land the caret under the skip-scroll tag so the reconcile
  // doesn't scroll either.
  editor.update(
    () => {
      const selection = $getSelection();
      if (selection !== null) selection.dirty = true;
      else $getRoot().selectStart();
    },
    { tag: SKIP_SCROLL_TAG },
  );
}

/**
 * Focus a CRDT-bound editor that may still be HYDRATING (per-block docs sync
 * async after mount, so a freshly-split/inserted block's root is empty for a
 * beat). Lexical's `editor.focus()` is a selection no-op on an empty root
 * (nothing to select → the reconciler never moves the DOM selection), which
 * left the caret stranded in the previous block. Instead: take DOM focus on
 * the (focusable) empty contenteditable NOW — the user's next keystrokes
 * belong to this block — and collapse the selection to the content START once
 * the first synced content commits (one-shot; skipped if the user moved focus
 * away or already placed a selection by typing meanwhile).
 *
 * Both paths land through {@link focusRestoringSelection}, so an editor that
 * already holds a caret keeps it and only a selection-less one is placed.
 * `scroll` (default false) declares whether the landing follows the caret into
 * view.
 *
 * `onLanded` fires on BOTH paths, at the moment the caret is really in this
 * editor — immediately when the root already has content, and from the one-shot
 * listener when it doesn't. That difference is the whole reason the caret
 * authority waits for caret-READY rather than for the mount: between the two, an
 * empty root has nothing to insert into, so anything typed must stay buffered.
 *
 * **The hydrating branch RESOLVES either way, and that is load-bearing.** When
 * the content arrives but DOM focus has moved off this root in the meantime, the
 * landing is dead — this editor is not where the user's keystrokes belong — so
 * the branch reports `onLandingLost` instead of `onLanded`. It used to report
 * NEITHER, on the stated grounds that "the authority's own focus-left abort owns
 * that case". That delegation is unsound in two ways, and both leave the caret
 * authority holding the keyboard with no abort and no report while the user
 * types into nothing:
 *
 *  - the authority aborts on `focusout` only when `relatedTarget` is an element
 *    OUTSIDE the block list; a steal landing on ANOTHER BLOCK inside it, or one
 *    that leaves `document.activeElement` on `<body>` (a `relatedTarget` of
 *    `null`, which the authority deliberately treats as a window blur), is
 *    invisible to it;
 *  - its other bound, `reconcile()`, only counts commits that render no line for
 *    the target — and the target IS rendered here, so `FLIGHT_MISS_LIMIT` can
 *    never trip.
 *
 * Reporting the loss is preferred over the alternative fix (leave the listener
 * armed and land on some later commit): the wait it would extend is unbounded by
 * anything, whereas an abort is bounded, replays the buffered keystrokes into the
 * block the user is ACTUALLY focused in, and files one caret-flight report. A
 * landing that may or may not happen later is exactly the absorbable failure the
 * `onLanded` contract exists to rule out.
 *
 * `place` replaces the default placement (restore the selection, else content
 * start) on BOTH branches, for a caller that wants the caret somewhere specific
 * in content that may not have arrived yet — a splice landing at the end of
 * pasted text in a block the same gesture just created.
 */
export function focusHydratingAware(
  editor: LexicalEditor,
  scroll = false,
  land?: Pick<CaretLandOptions, "onLanded" | "onLandingLost">,
  place?: () => void,
): void {
  const empty = editor
    .getEditorState()
    .read(() => $getRoot().getChildrenSize() === 0);
  if (!empty) {
    // Non-empty at focus time — since Stage 4a's instant pre-seed this is the
    // NORMAL path both for a freshly-split block (the tail is already in, no
    // selection yet → content start) and for a re-focus of the block the user
    // is already editing (selection present → restored untouched).
    if (place) place();
    else focusRestoringSelection(editor, scroll);
    land?.onLanded?.();
    return;
  }
  editor.getRootElement()?.focus(scroll ? undefined : { preventScroll: true });
  const unregister = editor.registerUpdateListener(() => {
    const ready = editor
      .getEditorState()
      .read(() => $getRoot().getChildrenSize() > 0);
    if (!ready) return;
    unregister();
    if (document.activeElement !== editor.getRootElement()) {
      land?.onLandingLost?.();
      return;
    }
    if (place) place();
    else {
      const hasSelection = editor
        .getEditorState()
        .read(() => $getSelection() !== null);
      if (!hasSelection) focusRestoringSelection(editor, scroll);
    }
    land?.onLanded?.();
  });
}

/**
 * Append `runs` to the end of the block's content and land the caret at the
 * JOIN offset (the content length before the append) — the Backspace-merge
 * concatenation. Computing the join from the LIVE editor (not `data.text`)
 * keeps the caret exact even when the target has unflushed edits.
 *
 * `discrete: true` for the same scope reason as
 * {@link truncateBlockTextFrom}: the merge runs this inside `untracked`.
 *
 * `scroll` defaults to TRUE: a Backspace-merge wants the joined caret revealed,
 * so callers keep today's `editor.focus()` + untagged update. A no-scroll caller
 * focuses the root with `preventScroll` and tags the update to suppress the
 * reconcile scroll.
 */
export function appendRunsAtJoin(
  editor: LexicalEditor,
  runs: RichText,
  scroll = true,
): void {
  // Focus BEFORE the append: the growth must happen under this block as the
  // scroll anchor, not the merged-away source below it (`focusEditor`).
  focusEditor(editor, scroll);
  editor.update(
    () => {
      const join = $paragraphsPlainLength();
      $appendRuns(runs, blockTextTokenExtensions());
      $placeCaretAtLinearOffset(join);
    },
    scroll ? { discrete: true } : { discrete: true, tag: SKIP_SCROLL_TAG },
  );
}
