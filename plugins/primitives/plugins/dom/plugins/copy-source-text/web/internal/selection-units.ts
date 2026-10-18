import { selectionRange } from "@plugins/primitives/plugins/dom/plugins/dom-selection/web";
import { COPY_SOURCE_ATTR } from "./attr";
import { isInsideEditable } from "./inside-editable";
import "./selection-units.css";

/**
 * Stamped on a substituting element while the document selection covers it;
 * `selection-units.css` paints the ring from it. Set and cleared only here.
 */
export const SELECTED_ATTR = "data-copy-text-selected";

/**
 * An element that STANDS IN for source text — a non-empty declaration. The
 * empty one (`copiesAsOwnText`, every `Badge`) substitutes nothing, so its own
 * letters are what it copies and they stay selectable one by one.
 */
const SUBSTITUTING = `[${COPY_SOURCE_ATTR}]:not([${COPY_SOURCE_ATTR}=""])`;

/**
 * The substituting elements a selection range covers, outside any editor.
 *
 * "Covers" is `intersectsNode`: any overlap counts, a range that merely ends
 * against the element's edge does not. Partial overlap counting as the whole is
 * the point — the copy handler replaces a partly-selected element with its FULL
 * declared text, so the ring has to say "all of it" too.
 *
 * Only the range's common ancestor is searched, so the cost is the selected
 * subtree's size, not the document's.
 */
export function selectedUnits(range: Range): Element[] {
  if (range.collapsed) return [];
  const common = range.commonAncestorContainer;
  const root =
    common instanceof Element || common instanceof Document
      ? common
      : common.parentElement;
  if (!root) return [];
  return Array.from(root.querySelectorAll(SUBSTITUTING)).filter(
    (element) => range.intersectsNode(element) && !isInsideEditable(element),
  );
}

/**
 * Install the document-level `selectionchange` listener that marks every
 * substituting element the selection covers. Returns its uninstaller.
 *
 * The browser's own highlight cannot express this. It paints characters, so a
 * drag ending halfway into a chip lit up half of its label — while the copy of
 * that same selection carried the whole token. The element's letters are made
 * unselectable in CSS (no per-character highlight), and this marks the element
 * itself, so the chip reads as one grabbed object: the same ring the prompt
 * editor paints on a selected chip decorator.
 *
 * Global for the same reason the copy handler is: the declaring elements are
 * spliced into other plugins' render trees. And it skips editors for the same
 * reason too — they ring their own chips.
 */
export function installSelectionUnits(): () => void {
  let marked = new Set<Element>();
  const onChange = () => {
    const range = selectionRange();
    const next = new Set(range ? selectedUnits(range) : []);
    for (const element of marked) {
      if (!next.has(element)) element.removeAttribute(SELECTED_ATTR);
    }
    for (const element of next) element.setAttribute(SELECTED_ATTR, "");
    marked = next;
  };
  document.addEventListener("selectionchange", onChange);
  return () => {
    document.removeEventListener("selectionchange", onChange);
    for (const element of marked) element.removeAttribute(SELECTED_ATTR);
  };
}
