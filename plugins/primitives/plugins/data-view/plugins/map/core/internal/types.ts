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
  /**
   * Where a map with a `cameraKey` opens (the map primitive's `cameraOpen`):
   * where the user left it (default), or `"framed"` on its pins (`focusIds`
   * included) while still remembering each rest under the key.
   */
  cameraOpen?: "remembered" | "framed";
  /**
   * Row keys drawn even where the view's search or filter hides them — rows
   * something beside the map stands for (a search's hits that are rows). The
   * selected row is always drawn; it needs no entry here.
   */
  keep?: ReadonlySet<string>;
  /** Non-row overlays drawn with the rows' pins (`MapExtraOverlays`). */
  overlays?: MapExtraOverlays;
  /**
   * A pin to draw hovered though the pointer is not on it — a row's id, or an
   * extra overlay's: the hover of whatever beside the map stands for it. Wins
   * over the surface's `hoveredRowId` while non-null.
   */
  hoveredId?: string | null;
  /** The pointer entered (`true`) or left (`false`) a pin — row pins and extra overlays alike. */
  onHoverChange?: (id: string, hovered: boolean) => void;
  /**
   * The camera came to rest: where, the area it shows, and the part of it the
   * chrome leaves uncovered (`CameraRest.visible`, re-reported when
   * `fitPadding` changes).
   */
  onCameraRest?: (rest: CameraRest) => void;
  /**
   * Re-frame on demand (the map primitive's `fitRequest`): each time the
   * number changes — not its value at mount — the map frames its pins as its
   * Fit control does.
   */
  fitRequest?: number;
  /**
   * The pins the camera frames, when set and non-empty (the map primitive's
   * `focusIds`): its first framing, the Fit control and each `fitRequest`
   * frame only these. Ids are the ids the map sees — a row's ROW KEY
   * (`rowKey`, the row pin's id) or an extra overlay's own `id`
   * (`overlays.items`) — so name a row by its key, as `keep` and `hoveredId`
   * do. A `frame: false` overlay stays out even when named. Absent or empty:
   * every framed pin.
   */
  focusIds?: readonly string[];
}
