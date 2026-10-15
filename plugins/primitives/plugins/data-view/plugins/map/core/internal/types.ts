import type { LatLng, MapCrowdRequest, MapPadding } from "@plugins/map/core";

/**
 * Per-view options for the map view, threaded through
 * `DataViewProps.viewOptions.map` and surfaced as the opaque
 * `DataViewRenderProps.options`.
 */
export interface MapViewOptions<TRow> {
  /**
   * The `pinType` every row's pin carries — the key `GeoMap.Pin` and
   * `GeoMap.Cluster` dispatch on, so a consumer contributes its own pin and
   * cluster look under a type it owns. Absent → a type no plugin claims, so the
   * map primitive's default pin and count disc draw it.
   */
  pinType?: string;
  /** The opaque payload handed to the pin component of `pinType` (`MapPin.data`). */
  pinData?: (row: TRow) => unknown;
  /** The pin's name (accessible label; what the default pin shows). Default:
   *  the primary field's value. */
  label?: (row: TRow) => string;
  /**
   * How pins that crowd each other are drawn (`MapCrowdRequest`): merged into
   * clusters, or kept as spots (every pin drawn; far out, each spot's size
   * beside its lead). Default `{ kind: "cluster" }` at the map primitive's
   * default radius; `false` draws every pin on its own.
   */
  crowd?: false | MapCrowdRequest;
  /**
   * The row's importance among its neighbours (`MapPin.rank`, default 0): a
   * higher rank draws above a lower one and leads its spot.
   */
  rank?: (row: TRow) => number;
  /**
   * The room, in px per edge, that the surface's floating chrome covers (an
   * aside, the floating toolbar, a detail card): the map frames its pins in
   * what is left and pans a selected pin out from under it. Default none.
   */
  fitPadding?: MapPadding;
  /**
   * Pick mode (the map primitive's `pick`): while set, the cursor is a
   * crosshair and a click on the map reports its position. Absent = off.
   */
  pick?: (position: LatLng) => void;
}
