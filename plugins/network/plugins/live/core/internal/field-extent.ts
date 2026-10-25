// A field's EXTENT — the range of its numeric values across the rows one view
// shows — handed to the cells of a field that asks for it (`extent: true` on
// its presentation, or on a data-view `FieldDef`), so a cell can draw its
// value against its peers (a play count's bar). Declared here, beside the
// field descriptors, because both halves name it: a presentation's cell
// (`network/live` web) and the field a list renders (`data-view` core).

/** The smallest and largest numeric value a field holds across a view's rows. */
export interface FieldExtent {
  readonly min: number;
  readonly max: number;
}

/**
 * What a field's cell is handed beside its row. `extent` is the field's
 * extent over the view's rows when the field declares `extent: true`; `null`
 * when no row of the view holds a numeric value of it — or when the cell is
 * drawn outside a view (a lone title, a cover), where there are no peers.
 */
export interface FieldCellContext {
  readonly extent: FieldExtent | null;
}

/**
 * The extent of `values` — every finite number among them — or `null` when
 * there is none.
 */
export function extentOf(values: Iterable<unknown>): FieldExtent | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : { min, max };
}
