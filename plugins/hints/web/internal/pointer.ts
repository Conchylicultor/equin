/**
 * `pointAt`'s model: a one-off highlight on an element the caller already
 * resolved — no declared anchor, no seen state. The store half lives in
 * `engine-store.ts` beside the tour it must not overlap; this file is the
 * part the host draws from.
 *
 * A highlight answers "where is it?" and never takes the page: no scrim, no
 * buttons, nothing to dismiss. It stays for {@link POINTER_LIFETIME_MS}, or
 * until the user's next move. A sequence the user steps through, waiting for
 * each answer, is a tour (`defineTour`) — the one modal guide.
 */

export interface PointAtOptions {
  /**
   * What the element is called. Drawn as a caption beside it only when the
   * element shows no text of its own (an icon-only button): next to a
   * labelled control the ring says which one, and a caption would only repeat
   * its label over its neighbours.
   */
  readonly label: string;
}

/** The highlight on screen: `id` is one showing (a replacing call is a new id). */
export interface PointerRun {
  readonly id: number;
  readonly el: HTMLElement;
  /** The caption drawn beside it — `null` when the element names itself. */
  readonly caption: string | null;
}

/** The caption a highlight on `el` draws: its label, unless `el` shows text of its own. */
export function captionFor(
  el: HTMLElement,
  opts: PointAtOptions,
): string | null {
  return el.innerText.trim() === "" ? opts.label : null;
}

/** How long a highlight stays when the user does nothing — long enough to find the ring (and read its caption). */
export const POINTER_LIFETIME_MS = 5000;
