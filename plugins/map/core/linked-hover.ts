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

/**
 * One linked hover as a store, so each surface reads only what it draws: a
 * row subscribes to whether IT is hovered, a map to the hovered id. Held as
 * state by the component owning the surfaces, a hover re-rendered that
 * component and everything under it on each pin the pointer crossed — the
 * Places screen re-rendered whole, 5–80×/s while the pointer glided over
 * its pins.
 */
export interface LinkedHover {
  /** The hovered id now (a primitive: a store snapshot). */
  get(): string | null;
  /** Call `listener` after each change; returns its removal. */
  subscribe(listener: () => void): () => void;
  /** A surface's claim or release (`nextLinkedHover`). */
  report: LinkedHoverChange;
}

/** A linked hover nobody holds yet. */
export function createLinkedHover(): LinkedHover {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report: (id, hovered) => {
      const next = nextLinkedHover(current, id, hovered);
      if (next === current) return;
      current = next;
      for (const l of listeners) l();
    },
  };
}

/**
 * A linked hover read through others: `get` derives the id from `sources`
 * (a page's row from the place hovered on the map, a ghost pin's id from the
 * result card hovered), and `report` routes a claim or release to the source
 * that owns it. Its readers re-read whenever any source changes; `get` must
 * be pure over the sources' `get()`s.
 */
export function deriveLinkedHover(
  sources: readonly LinkedHover[],
  get: () => string | null,
  report: LinkedHoverChange,
): LinkedHover {
  return {
    get,
    subscribe: (listener) => {
      const offs = sources.map((s) => s.subscribe(listener));
      return () => {
        for (const off of offs) off();
      };
    },
    report,
  };
}
