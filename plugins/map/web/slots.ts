import type { ComponentType, ReactNode } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { defineDispatchSlot } from "@plugins/primitives/plugins/slot-render/web";
import {
  clusterPinType,
  type LatLng,
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
  renderPin: (pin: MapPin, active: boolean) => ReactNode;
  /** A pin was clicked. */
  onActivate: (id: string) => void;
  activeId: string | null;
  /**
   * Group pins that sit closer than `radiusPx` on screen into one mark, drawn
   * with {@link renderCluster}. Absent = never cluster: every pin is drawn on
   * its own, exactly as before clustering existed. The active pin is never
   * clustered, so the selection stays visible at any zoom.
   */
  cluster?: { radiusPx: number };
  /**
   * The React content of one cluster — `GeoMap.Cluster`'s dispatch, already
   * isolated. Like {@link renderPin}, a renderer places it and never draws a
   * cluster of its own.
   */
  renderCluster: (pins: readonly MapPin[]) => ReactNode;
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

/** What a pin component receives. */
export interface MapPinProps {
  pin: MapPin;
  /** The pin is the selected one — grow and raise it. */
  active: boolean;
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
   * its type; the plugin that owns that type contributes how it looks. An
   * unclaimed type falls back to a neutral dot.
   */
  Pin: defineDispatchSlot<MapPinProps, string>({
    key: (props) => props.pin.pinType,
    fallback: DefaultPin,
  }),
  /**
   * Cluster appearance, keyed on the pinType its pins share — the owner of a
   * pin type contributes its cluster look next to its pin look. A cluster that
   * mixes types (or a type with no cluster contribution) falls back to a
   * neutral count disc.
   */
  Cluster: defineDispatchSlot<MapClusterProps, string>({
    key: (props) => clusterPinType(props.pins),
    fallback: DefaultCluster,
  }),
};
