import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import type { LatLng } from "@plugins/map/core";

/**
 * Where the content sits on its point: the point's place in the content's box,
 * in px from its top-left — a mark's `anchor`, so a pin lifted into the DOM
 * lands exactly where its sprite was drawn.
 */
export interface OverlayAnchor {
  x: number;
  y: number;
}

/**
 * The hovered pin's z-index: above every other pin, whatever their stack
 * order, so the label it shows on hover is never buried under a neighbour.
 */
const HOVERED_Z_INDEX = 2_147_483_647;

function anchorTransform(anchor: OverlayAnchor): string {
  return `translate(${-anchor.x}px, ${-anchor.y}px)`;
}

interface OverlayPinProps {
  position: LatLng;
  anchor: OverlayAnchor;
  label: string | undefined;
  zIndex: number;
  onActivate: () => void;
  /** The pointer entered (`true`) or left (`false`) the pin. */
  onHoverChange?: (hovered: boolean) => void;
  children: ReactNode;
}

/**
 * A pin's React content placed on the map through a plain `OverlayView`, NOT an
 * `AdvancedMarker`. Advanced Markers only exist on a map with a Map ID, and a
 * Map ID makes Google ignore the inline `styles` the canvas uses to hide its own
 * places — so pins are placed by hand and the map needs no Map ID at all.
 *
 * The content is anchored at `anchor` (its mark's), and the pin is a button: click, Enter or
 * Space activates it. While hovered it stacks above every other pin, so
 * whatever it reveals on hover (its name) draws over its neighbours. It sets
 * no `title`: pins show their own name, and the browser's tooltip would repeat it.
 */
export function OverlayPin({
  position,
  anchor,
  label,
  zIndex,
  onActivate,
  onHoverChange,
  children,
}: OverlayPinProps) {
  const map = useMap();
  const [hovered, setHovered] = useState(false);
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
    overlay?.stackAt(hovered ? HOVERED_Z_INDEX : zIndex);
  }, [overlay, zIndex, hovered]);

  const { x: ax, y: ay } = anchor;
  useEffect(() => {
    overlay?.anchorAt({ x: ax, y: ay });
  }, [overlay, ax, ay]);

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
      onClick={onActivate}
      onKeyDown={onKeyDown}
      onPointerEnter={() => {
        setHovered(true);
        onHoverChange?.(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
        onHoverChange?.(false);
      }}
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
      this.container.style.transform = anchorTransform(anchor);
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
