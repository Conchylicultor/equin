import { useEffect, useState } from "react";
import {
  APIProvider,
  Map as GoogleMap,
  Polygon,
  Polyline,
  useMap,
  type PolylineProps,
} from "@vis.gl/react-google-maps";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  cameraFor,
  overlayPositions,
  positionsKey,
  type MapArea,
  type MapOverlay,
  type MapPadding,
  type MapPath,
  type MapPin,
} from "@plugins/map/core";
import type { MapRendererProps } from "@plugins/map/web";
import {
  MapsMapAccessAction,
  useMapsBrowserConfig,
} from "@plugins/integrations/plugins/google-maps/web";
import { useGoogleAuthRefused } from "../internal/auth-failure";
import {
  DEFAULT_TONE,
  useToneColors,
  type ToneColors,
} from "../internal/tone-colors";
import { MapErrorCard } from "./map-error-card";
import { GOOGLE_COLOR_SCHEME, GOOGLE_TILES } from "../internal/tiles";
import { OverlayPin } from "./overlay-pin";
import { ClusteredPins } from "./clustered-pins";

/**
 * Google's own places (shops, museums, restaurants, parks' names) are hidden:
 * on a map whose content is the user's pins, they read as more pins and crowd
 * the real ones out. Streets, districts and transit stay as context, and parks
 * keep their green.
 *
 * Inline styles only apply to a map WITHOUT a Map ID, which is why pins are
 * `OverlayPin`s rather than Advanced Markers.
 */
const BASEMAP_STYLES: google.maps.MapTypeStyle[] = [
  {
    featureType: "poi",
    elementType: "labels",
    stylers: [{ visibility: "off" }],
  },
];
/** Room kept around fitted overlays, so an edge pin's bubble is not clipped. */
const FIT_PADDING_PX = 48;
/** Stroke width when an overlay does not say. */
const DEFAULT_STROKE_PX = 3;
/** Opacity of an area's fill under its outline. */
const AREA_FILL_OPACITY = 0.15;

/**
 * The Google Maps renderer. Reads the browser config itself rather than taking
 * it as a prop: `MapRendererProps` is vendor-neutral, and the host only mounts
 * this once readiness says the key is set.
 */
export function GoogleMapRenderer(props: MapRendererProps) {
  const config = useMapsBrowserConfig();
  switch (config.kind) {
    case "loading":
      return (
        <Center className="size-full">
          <Loading variant="spinner" />
        </Center>
      );
    case "error":
    // A failed config read (after the host saw it ready) — the access action
    // renders the failure with Retry.
    case "unset":
      // The key was removed after the host checked readiness — offer the same
      // fix the host would have.
      return (
        <Center className="size-full">
          <MapsMapAccessAction />
        </Center>
      );
    case "set":
      return <GoogleMapCanvas {...props} browserKey={config.browserKey} />;
  }
}

function GoogleMapCanvas({
  browserKey,
  overlays,
  renderPin,
  onActivate,
  activeId,
  cluster,
  renderCluster,
  focusId,
  fitPadding,
}: MapRendererProps & { browserKey: string }) {
  // Held in state, not a ref: the tone colours are read off this element, and
  // a ref cannot trigger the render that reads them.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const refused = useGoogleAuthRefused();
  const [loadError, setLoadError] = useState<string | null>(null);
  const colors = useToneColors(host, overlays);

  if (refused) return <MapErrorCard reason={{ kind: "refused" }} />;
  if (loadError !== null) {
    return <MapErrorCard reason={{ kind: "load", detail: loadError }} />;
  }

  const initial = cameraFor(overlayPositions(overlays));
  const center =
    initial.kind === "point"
      ? initial.center
      : initial.kind === "bounds"
        ? {
            lat: (initial.bounds.south + initial.bounds.north) / 2,
            lng: (initial.bounds.west + initial.bounds.east) / 2,
          }
        : { lat: 0, lng: 0 };

  return (
    <div ref={setHost} className="size-full">
      <APIProvider
        apiKey={browserKey}
        onError={(err) =>
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      >
        <GoogleMap
          styles={BASEMAP_STYLES}
          colorScheme={GOOGLE_COLOR_SCHEME[GOOGLE_TILES]}
          defaultCenter={center}
          defaultZoom={initial.kind === "point" ? initial.zoom : 2}
          // The wheel always zooms the map (no "Use ⌘ + scroll" hint), even
          // when the map sits inside a scrolling page.
          gestureHandling="greedy"
          clickableIcons={false}
          streetViewControl={false}
          mapTypeControl={false}
        >
          <FitCamera overlays={overlays} fitPadding={fitPadding} />
          <FocusCamera
            overlays={overlays}
            focusId={focusId}
            fitPadding={fitPadding}
          />
          {overlays.map((o) =>
            // Clustered pins are drawn together below, not one by one.
            cluster !== undefined && o.kind === "pin" ? null : (
              <OverlayNode
                key={o.id}
                overlay={o}
                colors={colors}
                active={o.id === activeId}
                renderPin={renderPin}
                onActivate={onActivate}
              />
            ),
          )}
          {cluster === undefined ? null : (
            <ClusteredPins
              pins={overlays.filter((o): o is MapPin => o.kind === "pin")}
              radiusPx={cluster.radiusPx}
              activeId={activeId}
              renderPin={renderPin}
              renderCluster={renderCluster}
              onActivate={onActivate}
              fitPadding={fitBoundsPadding(fitPadding)}
            />
          )}
        </GoogleMap>
      </APIProvider>
    </div>
  );
}

/**
 * Frames every overlay, but only when the SET of positions changes — so the
 * user's own pan and zoom survive edits that move nothing (a renamed place, a
 * re-render, a new unplaced item).
 */
function FitCamera({
  overlays,
  fitPadding,
}: {
  overlays: readonly MapOverlay[];
  fitPadding: MapPadding;
}) {
  const map = useMap();
  const positions = overlayPositions(overlays);
  const key = positionsKey(positions);
  const latest = useLatestRef(positions);
  // Read at fit time, never a trigger: chrome opening (a detail card) must not
  // reframe the user's map — FocusCamera brings a covered selection out.
  const padding = useLatestRef(fitPadding);

  useEffect(() => {
    if (map === null) return;
    const camera = cameraFor(latest.current);
    switch (camera.kind) {
      case "none":
        return;
      case "point":
        map.setZoom(camera.zoom);
        map.setCenter(paddedCenter(map, camera.center, padding.current));
        return;
      case "bounds":
        map.fitBounds(camera.bounds, fitBoundsPadding(padding.current));
        return;
    }
    // `key` is the trigger; `latest` / `padding` carry what it stands for.
  }, [map, key, latest, padding]);

  return null;
}

/**
 * Brings the focused pin into view when the focus (or the covered edges)
 * change: a pan, and only when the pin is off-screen or under the chrome — no
 * refit, no zoom, so the user's framing holds.
 */
function FocusCamera({
  overlays,
  focusId,
  fitPadding,
}: {
  overlays: readonly MapOverlay[];
  focusId: string | null;
  fitPadding: MapPadding;
}) {
  const map = useMap();
  const latest = useLatestRef(overlays);
  const padding = useLatestRef(fitPadding);
  // The covered edges are a trigger too: chrome that opens WITH the selection
  // (a detail card) is measured a render later, and may cover the pin then.
  const { top, right, bottom, left } = fitPadding;

  useEffect(() => {
    if (map === null || focusId === null) return;
    const pin = latest.current.find(
      (o): o is MapPin => o.kind === "pin" && o.id === focusId,
    );
    if (pin === undefined) return;
    // No bounds yet: the map has not laid out, and FitCamera's first framing
    // includes every pin, the focused one too.
    if (map.getBounds() === undefined) return;
    if (isInUncoveredArea(map, pin.position, padding.current)) return;
    map.panTo(paddedCenter(map, pin.position, padding.current));
    // `focusId` and the covered edges are the triggers; `latest` / `padding`
    // carry what they read.
  }, [map, focusId, latest, padding, top, right, bottom, left]);

  return null;
}

/** `fitBounds` padding: the renderer's own margin on top of the covered room. */
function fitBoundsPadding(pad: MapPadding): google.maps.Padding {
  return {
    top: FIT_PADDING_PX + pad.top,
    right: FIT_PADDING_PX + pad.right,
    bottom: FIT_PADDING_PX + pad.bottom,
    left: FIT_PADDING_PX + pad.left,
  };
}

/** The map's current top-left corner and pixel scale, in world coordinates. */
function viewport(map: google.maps.Map) {
  const bounds = map.getBounds();
  const projection = map.getProjection();
  const zoom = map.getZoom();
  if (bounds === undefined || projection == null || zoom === undefined) {
    return null;
  }
  const northWest = projection.fromLatLngToPoint(
    new google.maps.LatLng(
      bounds.getNorthEast().lat(),
      bounds.getSouthWest().lng(),
    ),
  );
  if (northWest === null) return null;
  return { projection, northWest, scale: 2 ** zoom };
}

/**
 * Whether a position sits on screen and outside the covered edges. Without a
 * laid-out projection it answers from the plain bounds.
 */
function isInUncoveredArea(
  map: google.maps.Map,
  position: google.maps.LatLngLiteral,
  pad: MapPadding,
): boolean {
  const view = viewport(map);
  const point = view?.projection.fromLatLngToPoint(position);
  if (view === null || point == null) {
    return map.getBounds()?.contains(position) ?? true;
  }
  const world = 256 * view.scale;
  // A view across the antimeridian: wrap the x offset into the world.
  const x =
    ((((point.x - view.northWest.x) * view.scale) % world) + world) % world;
  const y = (point.y - view.northWest.y) * view.scale;
  const div = map.getDiv();
  return (
    x >= pad.left &&
    x <= div.clientWidth - pad.right &&
    y >= pad.top &&
    y <= div.clientHeight - pad.bottom
  );
}

/**
 * The map centre that puts `position` in the middle of the UNCOVERED area —
 * shifted from the plain centre by half the difference of opposite paddings.
 */
function paddedCenter(
  map: google.maps.Map,
  position: google.maps.LatLngLiteral,
  pad: MapPadding,
): google.maps.LatLngLiteral | google.maps.LatLng {
  const projection = map.getProjection();
  const zoom = map.getZoom();
  const point = projection?.fromLatLngToPoint(position);
  if (projection == null || zoom === undefined || point == null) {
    return position;
  }
  const scale = 2 ** zoom;
  const shifted = new google.maps.Point(
    point.x - (pad.left - pad.right) / 2 / scale,
    point.y - (pad.top - pad.bottom) / 2 / scale,
  );
  return projection.fromPointToLatLng(shifted) ?? position;
}

interface OverlayNodeProps {
  overlay: MapOverlay;
  colors: ToneColors;
  active: boolean;
  renderPin: MapRendererProps["renderPin"];
  onActivate: MapRendererProps["onActivate"];
}

function OverlayNode({
  overlay,
  colors,
  active,
  renderPin,
  onActivate,
}: OverlayNodeProps) {
  switch (overlay.kind) {
    case "pin":
      return (
        <OverlayPin
          position={overlay.position}
          label={overlay.label}
          // The active pin sits above its neighbours, so a grown bubble is
          // never half-hidden under the next one.
          zIndex={active ? 2 : 1}
          onActivate={() => onActivate(overlay.id)}
        >
          {renderPin(overlay, active)}
        </OverlayPin>
      );
    case "path":
      return <PathNode path={overlay} colors={colors} />;
    case "area":
      return <AreaNode area={overlay} colors={colors} />;
  }
}

/**
 * A dashed stroke: Google has no dash option, so the line is drawn invisible
 * and a short vertical tick is repeated along it.
 */
function dashIcons(width: number): NonNullable<PolylineProps["icons"]> {
  return [
    {
      icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: width },
      offset: "0",
      repeat: `${width * 4}px`,
    },
  ];
}

function PathNode({ path, colors }: { path: MapPath; colors: ToneColors }) {
  const color = colors[path.style?.tone ?? DEFAULT_TONE];
  if (color === undefined) return null; // colour not resolved yet — never guess one
  const width = path.style?.width ?? DEFAULT_STROKE_PX;
  const dashed = path.style?.dashed === true;
  return (
    <Polyline
      path={path.points}
      strokeColor={color}
      strokeWeight={width}
      strokeOpacity={dashed ? 0 : 1}
      icons={dashed ? dashIcons(width) : undefined}
      clickable={false}
    />
  );
}

function AreaNode({ area, colors }: { area: MapArea; colors: ToneColors }) {
  const color = colors[area.style?.tone ?? DEFAULT_TONE];
  if (color === undefined) return null;
  const width = area.style?.width ?? DEFAULT_STROKE_PX;
  const dashed = area.style?.dashed === true;
  const first = area.ring[0];
  return (
    <>
      <Polygon
        paths={[area.ring]}
        fillColor={color}
        fillOpacity={AREA_FILL_OPACITY}
        strokeColor={color}
        strokeWeight={width}
        // A polygon's outline cannot dash either: draw it as a closed dashed
        // polyline over an outline-less fill.
        strokeOpacity={dashed ? 0 : 1}
        clickable={false}
      />
      {dashed && first !== undefined ? (
        <Polyline
          path={[...area.ring, first]}
          strokeColor={color}
          strokeWeight={width}
          strokeOpacity={0}
          icons={dashIcons(width)}
          clickable={false}
        />
      ) : null}
    </>
  );
}
