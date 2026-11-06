import { revealElement, type RevealOptions } from "./use-reveal-on-active";

export interface FocusElementOptions {
  /**
   * Whether moving focus also scrolls the element into view — REQUIRED, so
   * every focus call states it. `true` reveals it the way the browser's own
   * focus would (`nearest` on both axes); an object picks the reveal.
   *
   * - `true` when the focus FOLLOWS the user's own navigation to that element
   *   (arrow keys through a list, Tab into a cell, a shortcut to a search box):
   *   they are going there, and it may be off screen.
   * - `false` when focus is moved for them — restored, reclaimed, handed to a
   *   just-opened control, pulled back to a host: it must never move the page
   *   they are reading.
   */
  reveal: boolean | RevealOptions;
  /** `FocusOptions.focusVisible`: force (or suppress) the focus ring. */
  focusVisible?: boolean;
}

/**
 * Move DOM focus to `el` — the one sanctioned spelling of `element.focus()`.
 *
 * A bare `focus()` SCROLLS: the browser brings the focused element into view,
 * moving every scroller around it. That is an implicit scroll write, invisible
 * at the call site, and it moved the page under the reader more than once (a
 * table grip's menu: the table's caret host pulled focus back and the page
 * jumped by the table's height). So focus never scrolls here
 * (`preventScroll: true`); a reveal is asked for explicitly and runs through
 * {@link revealElement} — announced as a navigation, like every other reveal.
 *
 * `scroll-safety/no-scrolling-focus` bans a DOM `.focus()` anywhere else.
 */
export function focusElement(
  el: HTMLElement | SVGElement | null | undefined,
  opts: FocusElementOptions,
): void {
  if (!el) return;
  el.focus({ preventScroll: true, focusVisible: opts.focusVisible });
  if (opts.reveal === false) return;
  // Focus can be refused (a disabled control, an element the layout hides):
  // there is then nothing the user is going to, so nothing to reveal.
  if (document.activeElement !== el) return;
  revealElement(el, opts.reveal === true ? undefined : opts.reveal);
}
