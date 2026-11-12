import { useEffect } from "react";

/**
 * Whether the user is driving the page with the pointer or navigating it with
 * the keyboard, and what the focus rings read of it.
 *
 * `:focus-visible` alone is not enough. Chrome marks focus visible whenever the
 * last input was ANY key, so a popover opened with a click and closed with
 * Escape (or a submit shortcut) hands focus back to its trigger with a ring
 * the user never navigated to. Here only a NAVIGATION key — one that moves
 * focus or a highlight — flips the page back to keyboard; Escape, Enter and
 * typing do not. A pointer press flips it to pointer.
 *
 * Two marks, for two readers:
 *
 * - `data-input-modality="pointer"` on `<html>` (absent = keyboard) — the
 *   page's state, for script (`isPointerModality`). No stylesheet may read it.
 * - `data-pointer-focus` on the ONE focused element, while the page is in
 *   pointer modality — what the `focus-ring` utilities in `app.css` read
 *   (`:focus-visible:where(:not([data-pointer-focus]))`). Only the focused
 *   element can be `:focus-visible`, so it is the only element whose ring the
 *   modality can change.
 *
 * Why not one mark on `<html>`: a rule reading an attribute of the root makes
 * Chrome restyle every element that rule could match on each change of it —
 * every `focus-ring` host in the document, ~7,000 with four Sonata windows open
 * — on the page's first pointer press and on every Tab ⇄ click flip after it.
 * Marking the focused element restyles that element (and the `:has()` ring
 * hosts above it) alone. Measured by `ui-kit/e2e/input-modality-flip-cost.ts`.
 */
export function InputModalityTracker() {
  useEffect(() => trackInputModality(document), []);
  return null;
}

/**
 * Track the input modality of `doc` — the page's own (`InputModalityTracker`),
 * or another document the page draws into: a Document Picture-in-Picture
 * window, whose focus and input the page's listeners never see. Returns the
 * disposer.
 */
export function trackInputModality(doc: Document): () => void {
  const root = doc.documentElement;
  let marked: Element | null = null;
  /** Move the pointer-focus mark to where it belongs now. */
  const sync = () => {
    const target =
      root.dataset.inputModality === POINTER ? focusedElement(doc) : null;
    if (target === marked) return;
    marked?.removeAttribute(POINTER_FOCUS_ATTR);
    target?.setAttribute(POINTER_FOCUS_ATTR, "");
    marked = target;
  };
  const onPointer = () => {
    root.dataset.inputModality = POINTER;
    sync();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!NAVIGATION_KEYS.has(e.key)) return;
    delete root.dataset.inputModality;
    sync();
  };
  // Focus left an element (blurred, or removed with focus inside it): drop
  // the mark, so it holds no detached node. A move fires focusin next.
  const onFocusOut = () => {
    marked?.removeAttribute(POINTER_FOCUS_ATTR);
    marked = null;
  };
  doc.addEventListener("pointerdown", onPointer, true);
  // Observes every keystroke to tell navigation from pointer use; handles none.
  doc.addEventListener("keydown", onKey, true);
  // Focus moved (a click, a popup handing focus back, a script): the mark
  // follows it — before the frame is styled, as focusin fires synchronously.
  doc.addEventListener("focusin", sync, true);
  doc.addEventListener("focusout", onFocusOut, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointer, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("focusin", sync, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    marked?.removeAttribute(POINTER_FOCUS_ATTR);
    delete root.dataset.inputModality;
  };
}

/**
 * The focused element, through open shadow roots; null when none is. The
 * innermost one: a ring host whose own shadow root holds the focus is not
 * marked (no ring host has a shadow root today).
 */
function focusedElement(doc: Document): Element | null {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el === null || el === doc.body ? null : el;
}

const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const POINTER = "pointer";
/** Read by the `focus-ring*` utilities in `app.css` — keep the two in step. */
const POINTER_FOCUS_ATTR = "data-pointer-focus";

/**
 * Whether the user last drove `doc` with the pointer (as stamped by
 * `InputModalityTracker`) — e.g. a button focused by a click, which a key
 * should not treat as one the user navigated to.
 */
export function isPointerModality(doc: Document): boolean {
  return doc.documentElement.dataset.inputModality === POINTER;
}
