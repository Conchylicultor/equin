/**
 * The closed set of KEY SPACES a keyed companion slot dispatches on.
 *
 * A keyed companion is required only while something in the bundle USES its
 * key: the date table cell (`DataViewSlots.Cell({ match: "date" })`) ships in a
 * bundle that holds both the data-view primitive and a date field, the map view
 * renderer in one whose DataViews author a map view. Each space names where a
 * key's references come from — the closure engine reads them off the
 * `cross-refs` facet (`keyRefs`) — and that rule is the space's whole meaning:
 *
 * - `field-type` — a field type's id (`defineFieldType("date")`). Referenced by
 *   the plugin defining it (anything holding a date field imports the type's
 *   token) and by every plugin spelling `type: "date"` in a field definition.
 * - `view-type` — a DataView view renderer's type (`DataViewSlots.View({ type:
 *   "map" })`). Referenced by a plugin whose authored DataView config has a row
 *   of that view type, or whose call site whitelists it (`views={["map"]}`).
 *
 * Plain data, not a slot: the set is closed and both the slot declaration and
 * the build-time scanners need it.
 */
export const KEY_SPACES = ["field-type", "view-type"] as const;

export type KeySpace = (typeof KEY_SPACES)[number];

export function isKeySpace(s: string): s is KeySpace {
  return (KEY_SPACES as readonly string[]).includes(s);
}

/**
 * A slot's companions are required only when used: a contribution flagged
 * `companion: true` ships while the slot's owner ships AND some bundled plugin
 * references the value of its `key` prop in `space`.
 */
export interface KeyedCompanions {
  /** The contribution prop holding the key (`match`, `type`). */
  key: string;
  space: KeySpace;
}

/** `true`: every companion ships with the owner. Keyed: only the used ones. */
export type SlotCompanions = true | KeyedCompanions;
