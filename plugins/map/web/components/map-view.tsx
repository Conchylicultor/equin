import type { ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import {
  DEFAULT_CLUSTER_RADIUS_PX,
  NO_MAP_PADDING,
  type MapOverlay,
  type MapPadding,
  type MapPin,
} from "../../core";
import {
  GeoMap,
  type MapRendererProps,
  type MapRendererReadiness,
} from "../slots";

/** A renderer as the slot hands it back: `component` sealed, everything else readable. */
type RendererItem = ReturnType<typeof GeoMap.Renderer.useContributions>[number];

export interface MapViewProps {
  overlays: readonly MapOverlay[];
  /** The selected overlay's id; its pin renders `active`. */
  activeId?: string | null;
  /** A pin was clicked. */
  onActivate?: (id: string) => void;
  /**
   * Group pins that crowd each other on screen into one mark per group, drawn
   * through `GeoMap.Cluster`. Absent = never cluster. `radiusPx` defaults to
   * {@link DEFAULT_CLUSTER_RADIUS_PX}.
   */
  cluster?: { radiusPx?: number };
  /**
   * The pin to bring into view (a selected row, say). The map pans to it when
   * it changes and it is off-screen; it never refits or zooms for it.
   */
  focusId?: string | null;
  /**
   * The room chrome floating over the map covers on each edge, in px (a
   * sidebar, a toolbar, a card): fitting keeps pins out of it, and a focused
   * pin under it counts as off-screen. Default: none.
   */
  fitPadding?: MapPadding;
  /**
   * Shown instead of a map when there are no overlays — the host's own words
   * for "nothing to show yet". The renderer is never mounted for an empty map.
   */
  empty: ReactNode;
}

function ignoreActivate(): void {}

/**
 * The map host. Fills its parent: the caller owns the size.
 *
 * Picks the first `GeoMap.Renderer`, renders that renderer's set-up action while
 * it says it is blocked, and otherwise mounts it with every pin already routed
 * through `GeoMap.Pin` — so neither the caller nor the renderer ever styles a
 * pin, and neither names the other.
 */
export function MapView({
  overlays,
  activeId = null,
  onActivate = ignoreActivate,
  cluster,
  focusId = null,
  fitPadding = NO_MAP_PADDING,
  empty,
}: MapViewProps) {
  const renderer = GeoMap.Renderer.useContributions()[0];

  if (renderer === undefined) {
    return (
      <Center className="size-full">
        <Placeholder tone="error">
          No map renderer is installed, so there is nothing to draw this map
          with.
        </Placeholder>
      </Center>
    );
  }

  if (overlays.length === 0) {
    return <Center className="size-full">{empty}</Center>;
  }

  const tiles = renderer.tiles;
  const renderPin = (pin: MapPin, active: boolean) => (
    <GeoMap.Pin.Dispatch pin={pin} active={active} tiles={tiles} />
  );
  const renderCluster = (pins: readonly MapPin[]) => (
    <GeoMap.Cluster.Dispatch pins={pins} count={pins.length} tiles={tiles} />
  );
  const props: MapRendererProps = {
    overlays,
    renderPin,
    onActivate,
    activeId,
    cluster:
      cluster === undefined
        ? undefined
        : { radiusPx: cluster.radiusPx ?? DEFAULT_CLUSTER_RADIUS_PX },
    renderCluster,
    focusId,
    fitPadding,
  };
  return <RendererGate renderer={renderer} props={props} />;
}

interface GateProps {
  renderer: RendererItem;
  props: MapRendererProps;
}

/**
 * `renderIsolated` rather than the sealed component by hand: the host picks
 * the contribution itself (first wins), which `.Render` / `.Dispatch` cannot
 * express, and this still puts it through the slot's middleware chain — so a
 * renderer crash is contained to the map.
 */
function renderRenderer({ renderer, props }: GateProps): ReactNode {
  return renderIsolated(
    GeoMap.Renderer,
    renderer as unknown as Contribution,
    props,
  );
}

/**
 * `useReadiness` presence is stable per contribution (it is declared in the
 * contribution literal), so branching on it keeps both arms rules-of-hooks
 * clean — the shape the place block's provider gate uses.
 */
function RendererGate({ renderer, props }: GateProps) {
  if (renderer.useReadiness) {
    return (
      <GatedRenderer
        renderer={renderer}
        props={props}
        useReadiness={renderer.useReadiness}
      />
    );
  }
  return renderRenderer({ renderer, props });
}

function GatedRenderer({
  renderer,
  props,
  useReadiness,
}: GateProps & { useReadiness: Hook<() => MapRendererReadiness> }) {
  const readiness = useReadiness();
  switch (readiness) {
    case "pending":
      return (
        <Center className="size-full">
          <Loading variant="spinner" />
        </Center>
      );
    case "ready":
      return renderRenderer({ renderer, props });
    case "blocked": {
      const Action = renderer.AccessAction;
      return (
        <Center className="size-full">
          {Action ? (
            <Action />
          ) : (
            // A renderer that says it is blocked but offers no fix: say so
            // plainly rather than mounting a map whose every tile would fail.
            <Placeholder tone="error">
              {renderer.label} is not set up yet.
            </Placeholder>
          )}
        </Center>
      );
    }
  }
}
