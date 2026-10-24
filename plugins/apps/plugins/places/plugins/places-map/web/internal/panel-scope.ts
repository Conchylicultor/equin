import { boundsContain, type LatLng, type MapBounds } from "@plugins/map/core";
import type { PanelScope } from "./layout-stores";

/** What the side panel lists, and the counts its header and footer draw. */
export interface ScopedPlaces<T> {
  /** The rows the panel lists: those in view, or all of them. */
  shown: readonly T[];
  /** How many of the rows the uncovered map shows. */
  inView: number;
  /** How many it does not (off the map, or under the chrome). */
  outside: number;
}

/**
 * Scope the active preset's rows (already searched, filtered and sorted) to
 * the side panel: `"in-view"` keeps the rows whose position lies in `visible`
 * — the part of the map the floating chrome leaves uncovered — in their
 * order; `"all"` keeps every row. The counts are the same either way, so the
 * header can offer both.
 */
export function scopePlaces<T>(
  rows: readonly T[],
  visible: MapBounds,
  scope: PanelScope,
  at: (row: T) => LatLng,
): ScopedPlaces<T> {
  const inView = rows.filter((row) => boundsContain(visible, at(row)));
  return {
    shown: scope === "in-view" ? inView : rows,
    inView: inView.length,
    outside: rows.length - inView.length,
  };
}
