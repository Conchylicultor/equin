/**
 * Hover linked across surfaces (a list row and its map pin, a result card and
 * its ghost pin) as claims and releases, never a bare "nothing is hovered".
 *
 * Each surface reports `(id, true)` when the pointer enters one of its items
 * and `(id, false)` when it leaves it. A leave clears the linked hover only
 * while that id still holds it: two surfaces' reports for one pointer move
 * arrive in an order no one controls (React fires a row's `onPointerEnter`
 * from the same `pointerout` the map's leave comes from, and from a portal's
 * own container first), so a "nothing hovered" from the surface the pointer
 * just left must not erase the hover the surface it entered just claimed.
 */
export type LinkedHoverChange = (id: string, hovered: boolean) => void;

/** The linked hover after one report. */
export function nextLinkedHover(
  current: string | null,
  id: string,
  hovered: boolean,
): string | null {
  if (hovered) return id;
  return current === id ? null : current;
}
