import { useEffect, useMemo, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import type { LatLng } from "@plugins/map/core";

/**
 * Where the content sits on its point: a pin's tip (bottom centre, as an
 * Advanced Marker's), or a cluster disc's middle.
 */
export type OverlayAnchor = "bottom" | "center";

const ANCHOR_TRANSFORM: Record<OverlayAnchor, string> = {
  bottom: "translate(-50%, -100%)",
  center: "translate(-50%, -50%)",
};

interface OverlayPinProps {
  position: LatLng;
  /** Defaults to `bottom`. */
  anchor?: OverlayAnchor;
  label: string | undefined;
  zIndex: number;
  onActivate: () => void;
  children: ReactNode;
}

/**
 * A pin's React content placed on the map through a plain `OverlayView`, NOT an
 * `AdvancedMarker`. Advanced Markers only exist on a map with a Map ID, and a
 * Map ID makes Google ignore the inline `styles` the canvas uses to hide its own
 * places — so pins are placed by hand and the map needs no Map ID at all.
 *
 * The content is anchored at its bottom centre, as an Advanced Marker's is
 * (or at its centre, for a cluster), and the pin is a button: click, Enter or
 * Space activates it.
 */
export function OverlayPin({
  position,
  anchor = "bottom",
  label,
  zIndex,
  onActivate,
  children,
}: OverlayPinProps) {
  const map = useMap();
  const maps = useMapsLibrary("maps");
  // Built, not attached: attaching is the effect below.
  const overlay = useMemo(
    () => (maps === null ? null : createPinOverlay(maps)),
    [maps],
  );

  useEffect(() => {
    if (overlay === null || map === null) return;
    overlay.setMap(map);
    return () => overlay.setMap(null);
  }, [overlay, map]);

  useEffect(() => {
    overlay?.moveTo(position);
  }, [overlay, position]);

  useEffect(() => {
    overlay?.stackAt(zIndex);
  }, [overlay, zIndex]);

  useEffect(() => {
    overlay?.anchorAt(anchor);
  }, [overlay, anchor]);

  if (overlay === null) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onActivate();
  };
  return createPortal(
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    overlay.container,
  );
}

/**
 * The events a pin keeps from the map: a press on it is not the start of a pan,
 * a click is not a map click, a double click does not zoom. The wheel is
 * deliberately absent — it bubbles on so scrolling over a pin zooms the map as
 * it does anywhere else. Google's `preventMapHitsAndGesturesFrom` stops the
 * wheel too, which leaves the page to scroll (and bounce) under the cursor.
 */
const PIN_OWNED_EVENTS = [
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "mousedown",
  "pointerdown",
  "touchstart",
] as const;

function stopPropagation(e: Event) {
  e.stopPropagation();
}

interface PinOverlay extends google.maps.OverlayView {
  /** The element the pin's content is portalled into. */
  readonly container: HTMLDivElement;
  moveTo(position: LatLng): void;
  stackAt(zIndex: number): void;
  anchorAt(anchor: OverlayAnchor): void;
}

/**
 * Built per map library because `OverlayView` only exists once the Maps script
 * has loaded — a module-level subclass would throw at import.
 */
function createPinOverlay(maps: google.maps.MapsLibrary): PinOverlay {
  class Overlay extends maps.OverlayView implements PinOverlay {
    readonly container = document.createElement("div");
    private position: LatLng | null = null;

    constructor() {
      super();
      this.container.style.position = "absolute";
      // Bottom centre on the point, as an Advanced Marker anchors its content.
      this.container.style.transform = ANCHOR_TRANSFORM.bottom;
      for (const type of PIN_OWNED_EVENTS) {
        this.container.addEventListener(type, stopPropagation);
      }
    }

    moveTo(position: LatLng) {
      this.position = position;
      this.draw();
    }

    stackAt(zIndex: number) {
      this.container.style.zIndex = String(zIndex);
    }

    anchorAt(anchor: OverlayAnchor) {
      this.container.style.transform = ANCHOR_TRANSFORM[anchor];
    }

    override onAdd() {
      const panes = this.getPanes();
      if (panes == null) throw new Error("OverlayView added without panes");
      panes.overlayMouseTarget.appendChild(this.container);
    }

    override draw() {
      // Before onAdd there is no projection (null, despite the typings); Google
      // calls draw again once the overlay is on the map.
      const projection: google.maps.MapCanvasProjection | null =
        this.getProjection();
      if (this.position === null || projection == null) return;
      const point = projection.fromLatLngToDivPixel(this.position);
      if (point === null) return;
      this.container.style.left = `${point.x}px`;
      this.container.style.top = `${point.y}px`;
    }

    override onRemove() {
      this.container.remove();
    }
  }
  return new Overlay();
}
