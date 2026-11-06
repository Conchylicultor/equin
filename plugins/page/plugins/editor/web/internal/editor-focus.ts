import type { LexicalEditor } from "lexical";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/**
 * Lexical's `skip-scroll-into-view` update tag: suppresses the
 * `scrollIntoViewIfNeeded` that `updateDOMSelection` otherwise runs on every
 * collapsed-selection reconcile. Passed on the no-scroll path.
 */
export const SKIP_SCROLL_TAG = "skip-scroll-into-view";

/**
 * Take DOM focus for a caret landing — the ONE way a landing focuses a block's
 * editor, in both scroll modes.
 *
 * > **DOM focus moves to this editor FIRST, synchronously, before the landing
 * > edits anything.**
 *
 * Lexical's `editor.focus()` never calls `rootElement.focus()`: it only marks
 * the selection dirty, and DOM focus follows whenever the reconcile writes the
 * selection. Until then the PREVIOUS block stays `document.activeElement` — and
 * the focused editable is the browser's scroll-anchoring priority candidate. A
 * landing that grows this block in the same turn (a Backspace-merge appends the
 * source's text into the line above it) is then measured against an anchor
 * BELOW the growth, so the browser scrolls the page by exactly that growth and
 * every line above the caret jumps up (`e2e/merge-scroll-verify.ts`). Focusing
 * the root first makes the landing block the anchor, so its own growth shifts
 * nothing above it.
 *
 * The root focus is always `preventScroll` — revealing the caret is Lexical's
 * reconcile's job: a scroll-wanted landing keeps `editor.focus()` (selection
 * restore + an untagged reconcile, whose reveal also needs the root to be the
 * active element); a no-scroll landing tags its update {@link SKIP_SCROLL_TAG}.
 */
export function focusEditor(
  editor: LexicalEditor,
  scroll: boolean,
  defaultSelection?: "rootStart" | "rootEnd",
): void {
  focusElement(editor.getRootElement(), { reveal: false });
  if (scroll) editor.focus(undefined, { defaultSelection });
}
