import type {
  CameraRest,
  LatLng,
  MapCrowdRequest,
  MapOverlay,
  MapPadding,
} from "@plugins/map/core";

/**
 * Overlays the map draws beside the rows' pins — things that are not rows
 * (search hits proposed on the map, say). A click on one goes to
 * `onActivate`, never to the row activation. Mark them `frame: false` to keep
 * the camera off them.
 */
export interface MapExtraOverlays {
  items: readonly MapOverlay[];
  onActivate: (id: string) => void;
}

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
  /**
   * Remember the camera on this device under this key (the map primitive's
   * `cameraKey`): the map opens where the user left it, and frames its pins
   * only on a first visit. Absent = every visit frames the pins.
   */
  cameraKey?: string;
  /** Non-row overlays drawn with the rows' pins (`MapExtraOverlays`). */
  overlays?: MapExtraOverlays;
  /**
   * A pin to draw hovered though the pointer is not on it — a row's id, or an
   * extra overlay's: the hover of whatever beside the map stands for it.
   */
  hoveredId?: string | null;
  /** The pin under the pointer changed (`null`: none). */
  onHoverChange?: (id: string | null) => void;
  /** The camera came to rest: where, and the area it shows. */
  onCameraRest?: (rest: CameraRest) => void;
}
