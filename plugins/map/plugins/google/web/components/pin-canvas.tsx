import { useEffect, useMemo, useState } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import {
  cameraFor,
  type LatLng,
  type MapCrowd,
  type MapMark,
  type MapPin,
} from "@plugins/map/core";
import { useMapTextStyle, type MapRendererProps } from "@plugins/map/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  planPins,
  type PlannedItem,
} from "@plugins/map/plugins/pin-layer/core";
import {
  PinLayer,
  createCanvas2dPainter,
  type SceneItem,
} from "@plugins/map/plugins/pin-layer/web";
import { OverlayPin } from "./overlay-pin";
import { useMapProjection, usePlanZoom } from "../internal/projected-zoom";
import { GOOGLE_TILES } from "../internal/tiles";

/** How far a click on a cluster whose pins share one spot zooms in. */
const STACKED_CLUSTER_ZOOM_STEP = 2;

/**
 * The hovered pin's z-index: above every other lifted pin, whatever their
 * stack order, so the name it shows on hover is never buried.
 */
const HOVERED_Z_INDEX = 2_147_483_647;

interface PinCanvasProps {
  pins: readonly MapPin[];
  crowd: MapCrowd | undefined;
  activeId: string | null;
  renderPin: MapRendererProps["renderPin"];
  renderCluster: MapRendererProps["renderCluster"];
  markPin: MapRendererProps["markPin"];
  markCluster: MapRendererProps["markCluster"];
  onActivate: MapRendererProps["onActivate"];
  /** Room kept around a cluster's pins when a click frames them. */
  fitPadding: google.maps.Padding;
  /** Pick mode is on: a tap on the map picks, never activates a pin. */
  picking: boolean;
}

/** A planned item with its mark — what one canvas sprite or lifted DOM pin is made of. */
type Marked = PlannedItem & { mark: MapMark };

/**
 * Every pin on ONE canvas (`PinLayer`): a Google `OverlayView` holds a
 * viewport-sized canvas in the overlay pane and repaints it from the
 * projection on each `draw()` (every animation frame of a zoom) and each
 * `bounds_changed` (a drag) — one sprite per pin, no DOM per pin, so zooming
 * relayouts nothing.
 *
 * Only the pins being interacted with are DOM: the one under the pointer (the
 * canvas hit test runs on `pointermove`) and the active one render through
 * `renderPin` / `renderCluster` in an `OverlayPin` at their mark's anchor —
 * so a click always lands on a real button, and hover / selection keep their
 * transitions and names. A tap with no hover first (touch) is hit-tested on
 * the map's own click. The pins on screen are also listed for assistive tech
 * (and e2e), rebuilt when the camera comes to rest.
 */
export function PinCanvas({
  pins,
  crowd,
  activeId,
  renderPin,
  renderCluster,
  markPin,
  markCluster,
  onActivate,
  fitPadding,
  picking,
}: PinCanvasProps) {
  const map = useMap();
  const maps = useMapsLibrary("maps");
  const zoom = usePlanZoom(map);
  const text = useMapTextStyle();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [layerError, setLayerError] = useState<unknown>(null);
  if (layerError !== null) throw layerError;

  const host = useMemo(
    () =>
      maps === null
        ? null
        : createCanvasOverlay(maps, (err) => setLayerError(err)),
    [maps],
  );
  useEffect(() => {
    if (host === null || map === null) return;
    host.overlay.setMap(map);
    const bounds = map.addListener("bounds_changed", () => host.schedule());
    return () => {
      bounds.remove();
      host.overlay.setMap(null);
    };
  }, [host, map]);
  useEffect(() => () => host?.layer.dispose(), [host]);

  const projection = useMapProjection(map);
  const plan = useMemo(() => {
    if (projection == null || zoom === undefined) return null;
    const scale = 2 ** zoom;
    return planPins({
      pins,
      crowd,
      zoom,
      world: (pin) => {
        const p = projection.fromLatLngToPoint(pin.position);
        if (p === null)
          throw new Error(`Map projection cannot place pin ${pin.id}`);
        return { x: p.x * scale, y: p.y * scale };
      },
      activeId,
      hoveredId,
    });
  }, [pins, crowd, zoom, projection, activeId, hoveredId]);

  // Every pin's mark at each scale its crowd mode can draw, once per pin set
  // and mark function: a hover re-plans, it never rebuilds 1000 SVG strings.
  // Pending (an icon still loading) is left out until it lands.
  const scales: readonly ("near" | "far")[] =
    crowd?.kind === "spots" ? ["near", "far"] : ["near"];
  const scalesKey = scales.join(",");
  const pinMarks = useMemo(() => {
    const byPin = new Map<string, Partial<Record<"near" | "far", MapMark>>>();
    for (const pin of pins) {
      const marks: Partial<Record<"near" | "far", MapMark>> = {};
      for (const scale of scalesKey.split(",") as ("near" | "far")[]) {
        const r = markPin(pin, scale);
        if (r.kind === "mark") marks[scale] = r;
      }
      byPin.set(pin.id, marks);
    }
    return byPin;
  }, [pins, markPin, scalesKey]);
  const marked = useMemo<Marked[] | null>(() => {
    if (plan === null) return null;
    const out: Marked[] = [];
    for (const item of plan) {
      let mark: MapMark | undefined;
      if (item.kind === "pin") {
        mark = pinMarks.get(item.id)?.[item.scale];
      } else {
        const r = markCluster(item.pins);
        mark = r.kind === "mark" ? r : undefined;
      }
      if (mark !== undefined) out.push({ ...item, mark });
    }
    return out;
  }, [plan, markCluster, pinMarks]);

  const lifted = (item: Marked) =>
    item.id === hoveredId || item.id === activeId;

  useEffect(() => {
    if (host === null || marked === null) return;
    const scene: SceneItem[] = marked.map((item) => ({
      id: item.id,
      position: item.kind === "pin" ? item.pin.position : item.position,
      mark: item.mark,
      z: item.z,
      texts:
        item.kind === "pin" && item.spot !== undefined && !item.spot.hushed
          ? [{ at: "beside", text: String(item.spot.count) }]
          : [],
      lifted: item.id === hoveredId || item.id === activeId,
    }));
    host.setScene(scene, window.devicePixelRatio);
  }, [host, marked, hoveredId, activeId]);

  useEffect(() => {
    if (host === null || text === null) return;
    host.setText(text);
  }, [host, text]);

  const byId = useMemo(
    () => new Map((marked ?? []).map((m) => [m.id, m])),
    [marked],
  );

  const zoomTo = (members: readonly MapPin[]) => {
    // The exact zoom, not the plan's rounded one: the step is from where the
    // camera really is.
    const exact = map?.getZoom();
    if (map === null || exact === undefined) return;
    const camera = cameraFor(members.map((m) => m.position));
    switch (camera.kind) {
      case "none":
        return;
      case "point":
        // Every member is on the same spot: no zoom separates them, so step in.
        map.setCenter(camera.center);
        map.setZoom(exact + STACKED_CLUSTER_ZOOM_STEP);
        return;
      case "bounds":
        map.fitBounds(camera.bounds, fitPadding);
        return;
    }
  };
  const activateItem = (item: Marked) => {
    if (item.kind === "pin") onActivate(item.pin.id);
    else zoomTo(item.pins);
  };

  // Hover: the canvas hit test on every pointer move over the map, so the pin
  // under the pointer is lifted into the DOM before the press lands.
  useEffect(() => {
    if (host === null || map === null) return;
    const div = map.getDiv();
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons !== 0) return;
      const rect = div.getBoundingClientRect();
      const hit = host.layer.hitTest(
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      setHoveredId(hit?.id ?? null);
    };
    const onLeave = () => setHoveredId(null);
    div.addEventListener("pointermove", onMove);
    div.addEventListener("pointerleave", onLeave);
    return () => {
      div.removeEventListener("pointermove", onMove);
      div.removeEventListener("pointerleave", onLeave);
    };
  }, [host, map]);

  // A tap with no hover first (touch): the map's own click, hit-tested. A
  // lifted pin stops its own clicks, so a mouse click never lands here twice.
  const latestRef = useLatestRef({ byId, activateItem, picking });
  useEffect(() => {
    if (host === null || map === null) return;
    const listener = map.addListener(
      "click",
      (ev: google.maps.MapMouseEvent) => {
        const {
          picking: isPicking,
          byId: items,
          activateItem: activate,
        } = latestRef.current;
        const dom = ev.domEvent;
        if (isPicking || !("clientX" in dom)) return;
        const rect = map.getDiv().getBoundingClientRect();
        const hit = host.layer.hitTest(
          dom.clientX - rect.left,
          dom.clientY - rect.top,
        );
        const item = hit === null ? undefined : items.get(hit.id);
        if (item !== undefined) activate(item);
      },
    );
    return () => listener.remove();
  }, [host, map, latestRef]);

  // The pins on screen, for assistive tech and e2e: rebuilt at rest only, so a
  // zoom frame touches no DOM.
  const [onScreen, setOnScreen] = useState<readonly ListedPin[]>([]);
  useEffect(() => {
    if (host === null || map === null) return;
    const refresh = () => {
      setOnScreen(
        host.layer.onScreen().map(({ item, box }) => {
          const m = byId.get(item.id);
          // Where a pointer finds the pin: its box's middle — reachable when
          // the hit test there answers this pin (not one stacked over it).
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return {
            id: item.id,
            label:
              m === undefined
                ? item.id
                : m.kind === "pin"
                  ? (m.pin.label ?? "Map pin")
                  : `${m.pins.length} pins — zoom in`,
            x: Math.round(x),
            y: Math.round(y),
            reachable: host.layer.hitTest(x, y)?.id === item.id,
          };
        }),
      );
    };
    const offShown = host.onSceneShown(refresh);
    const idle = map.addListener("idle", refresh);
    return () => {
      idle.remove();
      offShown();
    };
  }, [host, map, byId]);

  if (marked === null) return null;
  const liftedItems = marked.filter(lifted);
  return (
    <>
      {liftedItems.map((item) => (
        <OverlayPin
          key={item.id}
          position={item.kind === "pin" ? item.pin.position : item.position}
          anchor={item.mark.anchor}
          label={
            item.kind === "pin"
              ? item.pin.label
              : `${item.pins.length} pins — zoom in`
          }
          zIndex={item.id === hoveredId ? HOVERED_Z_INDEX : item.z}
          onActivate={() => activateItem(item)}
        >
          {item.kind === "pin"
            ? renderPin(item.pin, {
                active: item.id === activeId,
                scale: item.scale,
                ...(item.spot === undefined ? {} : { spot: item.spot }),
              })
            : renderCluster(item.pins)}
        </OverlayPin>
      ))}
      <PinList
        pins={onScreen}
        onActivate={(id) => {
          const item = byId.get(id);
          if (item !== undefined) activateItem(item);
        }}
      />
    </>
  );
}

interface ListedPin {
  id: string;
  label: string;
  /** Where the pointer finds the pin, px from the map's top-left (`data-x` / `data-y`). */
  x: number;
  y: number;
  /** No other pin is stacked over that point (`data-reachable`). */
  reachable: boolean;
}

/**
 * The pins on screen as a visually hidden list of buttons — how the keyboard
 * and assistive tech reach pins drawn on a canvas, and what e2e scripts find
 * them by (`[data-map-pins]`). Static between camera rests: no layout per frame.
 */
function PinList({
  pins,
  onActivate,
}: {
  pins: readonly ListedPin[];
  onActivate: (id: string) => void;
}) {
  return (
    <div data-map-pins="" className="sr-only">
      {pins.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-label={p.label}
          data-x={p.x}
          data-y={p.y}
          data-reachable={p.reachable}
          onClick={() => onActivate(p.id)}
        />
      ))}
    </div>
  );
}

interface CanvasHost {
  overlay: google.maps.OverlayView;
  layer: PinLayer;
  setScene(scene: readonly SceneItem[], dpr: number): void;
  setText(text: NonNullable<ReturnType<typeof useMapTextStyle>>): void;
  /** Repaint on the next animation frame (coalesced). */
  schedule(): void;
  /** Call `listener` each time a new scene has been painted (the on-screen list refreshes from it); returns its removal. */
  onSceneShown(listener: () => void): () => void;
}

/**
 * The canvas and its `OverlayView`. Built per map library because `OverlayView`
 * only exists once the Maps script has loaded.
 */
function createCanvasOverlay(
  maps: google.maps.MapsLibrary,
  fail: (err: unknown) => void,
): CanvasHost {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.pointerEvents = "none";
  canvas.dataset.mapPinCanvas = "";
  let text: NonNullable<ReturnType<typeof useMapTextStyle>> | null = null;
  let frame: number | null = null;
  const shownListeners = new Set<() => void>();

  class Overlay extends maps.OverlayView {
    override onAdd() {
      const panes = this.getPanes();
      if (panes == null) throw new Error("OverlayView added without panes");
      panes.overlayLayer.appendChild(canvas);
    }
    override draw() {
      paint();
    }
    override onRemove() {
      canvas.remove();
    }
  }
  const overlay = new Overlay();

  const paint = () => {
    // Before onAdd there is no projection (null, despite the typings).
    const projection: google.maps.MapCanvasProjection | null =
      overlay.getProjection();
    const map = overlay.getMap();
    if (
      projection == null ||
      text === null ||
      !(map instanceof google.maps.Map)
    ) {
      return;
    }
    const div = map.getDiv();
    const width = div.clientWidth;
    const height = div.clientHeight;
    // The canvas covers the map's viewport: its top-left on the container's,
    // in div pixels — measured through the centre, the one point whose
    // projection never wraps (a world-zoom corner sits past the poles or the
    // antimeridian).
    const center = map.getCenter();
    if (center === undefined) return;
    const inDiv = projection.fromLatLngToDivPixel(center);
    const inContainer = projection.fromLatLngToContainerPixel(center);
    if (inDiv === null || inContainer === null) return;
    const origin = { x: inDiv.x - inContainer.x, y: inDiv.y - inContainer.y };
    canvas.style.left = `${origin.x}px`;
    canvas.style.top = `${origin.y}px`;
    layer.render({
      width,
      height,
      dpr: window.devicePixelRatio,
      tiles: GOOGLE_TILES,
      text,
      project: (position: LatLng) => {
        const p = projection.fromLatLngToContainerPixel(position);
        if (p === null) throw new Error("Map projection cannot place a pin");
        return { x: p.x, y: p.y };
      },
    });
  };
  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paint();
    });
  };
  // A scene swapped in paints at once (a frame late would flash the lifted
  // pin twice: in the DOM and still on the canvas).
  const layer = new PinLayer(
    createCanvas2dPainter(canvas),
    () => {
      paint();
      for (const l of shownListeners) l();
    },
    fail,
  );

  const host: CanvasHost = {
    overlay,
    layer,
    setScene: (scene, dpr) => layer.setScene(scene, dpr),
    setText: (t) => {
      text = t;
      schedule();
    },
    schedule,
    onSceneShown: (listener) => {
      shownListeners.add(listener);
      return () => shownListeners.delete(listener);
    },
  };
  return host;
}
