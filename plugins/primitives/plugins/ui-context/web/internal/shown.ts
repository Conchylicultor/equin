/**
 * What counts as a control on the page, and whether it is on screen — the one
 * definition the outline (`collectOutline`) and its inverse (`resolveUiContext`)
 * share, so an entry the outline lists is exactly what a resolve can find again.
 */

/** Elements a person operates: native controls and their ARIA twins. */
export const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  ...[
    "button",
    "link",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "switch",
    "checkbox",
    "radio",
    "option",
    "combobox",
    "treeitem",
    "slider",
    "searchbox",
    "textbox",
    "gridcell",
  ].map((r) => `[role="${r}"]`),
].join(", ");

/** An element whose subtree is withdrawn from the page as a person meets it:
 *  hidden, removed from the accessibility tree, or inert. */
export const WITHDRAWN_SELECTOR = '[hidden], [aria-hidden="true"], [inert]';

/** True when `el` itself withdraws its subtree (see {@link WITHDRAWN_SELECTOR}). */
export function withdraws(el: Element): boolean {
  return el.matches(WITHDRAWN_SELECTOR);
}

/**
 * True when `el` is drawn: it has a box with area, and is not
 * `visibility: hidden` (nor `display: none`, which leaves no box). Off-screen
 * (scrolled out of view) still counts — it is on the page, a scroll away.
 *
 * `checkVisibility` covers the ancestors' `display` / `content-visibility` /
 * `visibility` in one call; where it is missing, the element's own computed
 * `visibility` (inherited) stands in.
 */
export function isDrawn(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (typeof el.checkVisibility === "function")
    return el.checkVisibility({ visibilityProperty: true });
  return getComputedStyle(el).visibility !== "hidden";
}

/** True when `el` is shown to a person: drawn, and no ancestor withdraws it. */
export function isShown(el: Element): boolean {
  return el.closest(WITHDRAWN_SELECTOR) === null && isDrawn(el);
}
