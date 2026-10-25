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
  /** The caption beside the highlighted element. */
  readonly body: string;
}

/** The highlight on screen: `id` is one showing (a replacing call is a new id). */
export interface PointerRun {
  readonly id: number;
  readonly el: HTMLElement;
  readonly opts: PointAtOptions;
}

/** How long a highlight stays when the user does nothing — long enough to read its caption. */
export const POINTER_LIFETIME_MS = 5000;
