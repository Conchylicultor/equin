import type { ComponentType, ReactNode } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { defineDispatchSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { IconMarkupReader } from "@plugins/ui/plugins/icons/web";
import {
  clusterPinType,
  type CameraView,
  type LatLng,
  type MapCrowd,
  type MapMarkResult,
  type MapOverlay,
  type MapPadding,
  type MapPin,
  type MapTileScheme,
} from "../core";
import { DefaultCluster } from "./components/default-cluster";
import { DefaultPin } from "./components/default-pin";

/** What a renderer is handed. Pins arrive pre-rendered through {@link MapRendererProps.renderPin}. */
export interface MapRendererProps {
  /** Never empty: the host shows its empty state instead of mounting a renderer. */
  overlays: readonly MapOverlay[];
  /**
   * The React content of one pin — `GeoMap.Pin`'s dispatch, already isolated.
   * A renderer places it; it never draws a pin of its own.
   */
  renderPin: (pin: MapPin, state: MapPinState) => ReactNode;
  /**
   * The pin's mark at `scale` — `GeoMap.Pin`'s `mark`, the SAME look its
   * component draws. A renderer draws every pin at rest from it (one surface,
   * cached sprites) and lifts only the pins being interacted with (hovered,
   * active) into the DOM through {@link renderPin}, placed so the mark's
   * anchor sits on the point — so lifting a pin moves no pixel.
   */
  markPin: (pin: MapPin, scale: MapPinScale) => MapMarkResult;
  /** A pin was clicked. */
  onActivate: (id: string) => void;
  activeId: string | null;
  /**
   * How pins that crowd each other are drawn (`MapCrowd`). Absent = every pin
   * on its own, near, at every zoom.
   *
   * - `cluster`: pins closer than `radiusPx` on screen merge into one mark,
   *   drawn with {@link renderCluster}. The active pin is never clustered.
   * - `spots`: every pin stays drawn. Below `nearZoom` each is drawn `far`,
   *   anchored at its centre (near: at its bottom centre), and the pins within
   *   `radiusPx` of each other form a spot whose lead — the active pin, else
   *   the highest `rank` — is handed `spot`. A spot is re-formed on zoom only.
   *
   * In every mode a pin's stacking follows `pinStackOrder` (rank, active on top).
   */
  crowd?: MapCrowd;
  /**
   * The React content of one cluster — `GeoMap.Cluster`'s dispatch, already
   * isolated. Like {@link renderPin}, a renderer places it and never draws a
   * cluster of its own.
   */
  renderCluster: (pins: readonly MapPin[]) => ReactNode;
  /** A cluster's mark — `GeoMap.Cluster`'s `mark`, as {@link markPin} is a pin's. */
  markCluster: (pins: readonly MapPin[]) => MapMarkResult;
  /**
   * The pin to bring into view. When it changes, the renderer pans to it if it
   * is off-screen — no refit and no zoom change, so the user's framing holds.
   */
  focusId: string | null;
  /**
   * The room floating chrome covers on each edge, in px. Fitting frames the
   * overlays inside what is left (on top of the renderer's own margin), and
   * {@link focusId} treats a pin under the chrome as off-screen, panning it to
   * the middle of the uncovered area. All zeros when nothing floats.
   */
  fitPadding: MapPadding;
  /**
   * Pick mode: while set, the map asks for a point — the cursor is a
   * crosshair, and a click on the map itself (not on a pin) reports where it
   * landed. Absent = a click on the map does nothing.
   */
  pick?: (position: LatLng) => void;
  /**
   * Where the camera opens — a view the user left, restored. Read once, at
   * mount: when set, the renderer opens there and never makes its one framing
   * of the overlays (the Fit control still frames on demand). Absent: the
   * camera frames the overlays the first time there are any.
   */
  initialCamera?: CameraView;
  /**
   * The camera came to rest (a pan, a zoom, a fit or a flight ended), while
   * the map has overlays — so an empty map's world view is never reported as
   * where the user left it.
   */
  onCameraRest?: (view: CameraView) => void;
}

/**
 * Whether a renderer can draw right now. Three states, not a boolean: while the
 * renderer's configuration is still loading the host shows a loading state —
 * never the set-up action, which would claim "nothing is configured" and then
 * reverse itself.
 */
export type MapRendererReadiness = "pending" | "ready" | "blocked";

/**
 * A map engine. The host picks the first contribution; the rest of the app
 * never names one, so the vendor lives in exactly one plugin.
 *
 * `AccessAction` + `useReadiness` are `Place.Provider`'s contract, widened to
 * three states: the host can say "this map is not usable yet" and render the
 * control that fixes it, without knowing whether the blocker is a key, a
 * token, or a service the user has not enabled.
 */
export interface MapRendererContribution {
  id: string;
  /** Human name of the engine. */
  label: string;
  component: ComponentType<MapRendererProps>;
  /**
   * The scheme the engine draws its tiles in. Required: every pin's label ink
   * is chosen from it, and a renderer that left it out would silently hand pins
   * the app theme's ink instead — light text on light tiles under a dark theme.
   * The renderer must also make it TRUE (pin the engine's own colour scheme).
   */
  tiles: MapTileScheme;
  /** Rendered in place of the map while {@link useReadiness} says `blocked`. */
  AccessAction?: ComponentType;
  /**
   * Reactive readiness. Omitted = always ready.
   *
   * Presence must be STABLE per contribution (declare it in the contribution
   * literal, never conditionally): the host branches on whether it exists to
   * keep both arms rules-of-hooks clean.
   */
  useReadiness?: Hook<() => MapRendererReadiness>;
}

/**
 * How far out a pin is drawn. `near`: the full pin, anchored at its bottom
 * centre. `far` (spots mode, below its near zoom): a compact mark anchored at
 * its CENTRE — the renderer anchors it, so the pin must draw centred.
 */
export type MapPinScale = "near" | "far";

/** What the renderer says about one pin, beyond the pin's own data. */
export interface MapPinState {
  /** The pin is the selected one — grow and raise it. */
  active: boolean;
  scale: MapPinScale;
  /**
   * Set only on the lead of a far spot holding more than one pin: draw the
   * spot's size beside the pin. `hushed` while a pin of the spot is hovered —
   * fade the count so the hovered name reads alone.
   */
  spot?: { count: number; hushed: boolean };
}

/** What a pin component receives. */
export interface MapPinProps extends MapPinState {
  pin: MapPin;
  /** The scheme of the tiles the pin is drawn on — draw its name with {@link MapLabel}. */
  tiles: MapTileScheme;
}

/** What a cluster component receives. */
export interface MapClusterProps {
  /** The pins the cluster stands for; never empty. */
  pins: readonly MapPin[];
  /** `pins.length`, spelled out for the common case of drawing the count. */
  count: number;
  /** The scheme of the tiles the cluster is drawn on. */
  tiles: MapTileScheme;
}

/**
 * What a mark function is handed besides its pin: the readers a pure function
 * cannot reach itself. Colours and icons are resolved in the map's own theme
 * scope, so a mark matches what the DOM would paint there.
 */
export interface MapMarkEnv {
  /** An icon as SVG markup, in this scope's icon style. */
  icon: IconMarkupReader;
  /**
   * Any CSS colour — a token (`var(--primary)`), `color-mix(…)`, relative
   * `oklch(from …)` — as the concrete colour the browser computes for it here.
   * A mark's SVG may hold only concrete colours (`markSvgProblem`).
   */
  color: (css: string) => string;
  /** The scheme of the tiles the mark is drawn on. */
  tiles: MapTileScheme;
}

/** What a pin's mark depends on: its data, its scale and the tiles — never hover or selection, which the DOM draws. */
export interface MapPinMarkInput {
  pin: MapPin;
  scale: MapPinScale;
}

/** A pin type's mark: pure — everything it reads comes in. */
export type MapPinMarkFn = (
  input: MapPinMarkInput,
  env: MapMarkEnv,
) => MapMarkResult;

/** A cluster's mark. */
export type MapClusterMarkFn = (
  input: { pins: readonly MapPin[]; count: number },
  env: MapMarkEnv,
) => MapMarkResult;

export const GeoMap = {
  /**
   * Map engines contribute here. First contribution wins; none at all is a
   * loud "no map renderer installed" state, not a blank box.
   */
  Renderer: defineSlot<MapRendererContribution>({
    docLabel: (r) => r.label,
  }),
  /**
   * Pin appearance, keyed on `pin.pinType`. The layer that makes a pin picks
   * its type; the plugin that owns that type contributes how it looks: its
   * `mark` (the pin at rest, as an image) and its `component` (the pin lifted
   * into the DOM while hovered or active), which draws the same mark through
   * `MapMarkImage`. An unclaimed type falls back to a neutral dot.
   */
  Pin: defineDispatchSlot<MapPinProps, string, { mark: MapPinMarkFn }>({
    key: (props) => props.pin.pinType,
    fallback: DefaultPin,
  }),
  /**
   * Cluster appearance, keyed on the pinType its pins share — the owner of a
   * pin type contributes its cluster look next to its pin look. A cluster that
   * mixes types (or a type with no cluster contribution) falls back to a
   * neutral count disc.
   */
  Cluster: defineDispatchSlot<
    MapClusterProps,
    string,
    { mark: MapClusterMarkFn }
  >({
    key: (props) => clusterPinType(props.pins),
    fallback: DefaultCluster,
  }),
};
