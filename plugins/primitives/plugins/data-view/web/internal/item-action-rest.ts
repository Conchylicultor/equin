import type {
  ItemActionEntry,
  ItemActionFilter,
  ItemActionZone,
} from "../../core";

/**
 * THE rest rule — whether an action stays painted without hover. The only
 * place it is spelled; `useItemActionZones` (which arms a view gets) and each
 * drawn action cell (whether it lands in the at-rest or the hover arm) both
 * read it, so the two cannot disagree.
 *
 * - `persistent` rests — unless it declares `useActive`, then only while active.
 * - `revealed` / `primary` rest only while active.
 * - `demotePrimary` (the view has no primary slot, e.g. the table): a
 *   `primary` action ALWAYS rests, whatever its `useActive` says. The row's
 *   main verb (Sonata's Play) has nowhere else to show at rest, so a view
 *   without the slot keeps it painted rather than hiding it behind hover.
 *
 * `active` is `undefined` when the action declares no `useActive`.
 */
export function itemActionRests(
  zone: ItemActionZone,
  active: boolean | undefined,
  demotePrimary: boolean,
): boolean {
  if (zone === "primary" && demotePrimary) return true;
  return zone === "persistent" ? (active ?? true) : active === true;
}

/** Whether one action, in this row's state, is drawn by a `Row` with `filter`.
 *  The zone half of the filter is applied by the caller (it is static). */
export function itemActionPasses(
  zone: ItemActionZone,
  active: boolean | undefined,
  filter: ItemActionFilter,
): boolean {
  if (filter.rest === undefined) return true;
  return (
    itemActionRests(zone, active, filter.demotePrimary ?? false) === filter.rest
  );
}

/** Could `entry` land in the arm whose rows filter on `rest`, for SOME row? A
 *  row-independent action has one answer; a `useActive` one may go either way. */
export function itemActionCanRest(
  entry: ItemActionEntry,
  rest: boolean,
  demotePrimary: boolean,
): boolean {
  const states: readonly (boolean | undefined)[] = entry.hasActive
    ? [true, false]
    : [undefined];
  return states.some(
    (active) => itemActionRests(entry.zone, active, demotePrimary) === rest,
  );
}
